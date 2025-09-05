import { password } from "~/store"
import { EmptyResp } from "~/types"
import { r, pathDir } from "~/utils"
import { SetUpload, Upload } from "./types"
import pLimit from "p-limit"
import {
  calculateHash,
  calculateSliceHash,
  fsUploadInfo,
  fsPreup,
  FsSliceupComplete,
  HashType,
} from "./util"
import createMutex from "~/utils/mutex"

// 重试配置
const RETRY_CONFIG = {
  maxRetries: 5, // 增加重试次数
  retryDelay: 1000, // 基础延迟1秒
  maxDelay: 30000, // 最大延迟30秒
  backoffMultiplier: 2, // 指数退避
  // 服务器重启检测
  serverHealthCheckDelay: 5000, // 服务器健康检查延迟
  serverRestartRetries: 3, // 服务器重启后的特殊重试次数
}

// 服务器状态检测
class ServerHealthChecker {
  private static instance: ServerHealthChecker
  private lastHealthCheck = 0
  private serverOnline = true
  private checkPromise: Promise<boolean> | null = null

  static getInstance(): ServerHealthChecker {
    if (!ServerHealthChecker.instance) {
      ServerHealthChecker.instance = new ServerHealthChecker()
    }
    return ServerHealthChecker.instance
  }

  async isServerHealthy(): Promise<boolean> {
    const now = Date.now()
    
    // 如果最近检查过且结果为在线，直接返回
    if (this.serverOnline && now - this.lastHealthCheck < 10000) {
      return true
    }

    // 防止并发检查
    if (this.checkPromise) {
      return this.checkPromise
    }

    this.checkPromise = this.performHealthCheck()
    try {
      const result = await this.checkPromise
      this.lastHealthCheck = now
      this.serverOnline = result
      return result
    } finally {
      this.checkPromise = null
    }
  }

  private async performHealthCheck(): Promise<boolean> {
    try {
      const response = await r.get('/ping', {
        timeout: 5000,
        headers: { Password: password() }
      })
      return response.status === 200
    } catch (error: any) {
      console.warn('Server health check failed:', error.message)
      return false
    }
  }

  markServerOffline(): void {
    this.serverOnline = false
  }

  async waitForServerRecovery(maxWaitTime = 60000): Promise<boolean> {
    const startTime = Date.now()
    let attempt = 1
    
    console.log('等待服务器恢复...')
    
    while (Date.now() - startTime < maxWaitTime) {
      const isHealthy = await this.isServerHealthy()
      if (isHealthy) {
        console.log(`服务器已恢复 (第${attempt}次检查)`)
        return true
      }
      
      const waitTime = Math.min(5000 * attempt, 15000) // 渐进式等待
      console.log(`服务器检查失败，${waitTime/1000}秒后重试...`)
      await new Promise(resolve => setTimeout(resolve, waitTime))
      attempt++
    }
    
    console.error('服务器恢复超时')
    return false
  }
}

// 错误类型定义
enum UploadErrorType {
  NETWORK_ERROR = 'network_error',
  SERVER_ERROR = 'server_error', 
  FILE_ERROR = 'file_error',
  CANCEL_ERROR = 'cancel_error',
  TIMEOUT_ERROR = 'timeout_error',
  HASH_ERROR = 'hash_error',
  MEMORY_ERROR = 'memory_error'
}

class UploadError extends Error {
  public type: UploadErrorType
  public statusCode?: number
  public retryable: boolean
  public userMessage: string

  constructor(
    type: UploadErrorType, 
    message: string, 
    userMessage: string,
    statusCode?: number,
    retryable: boolean = true
  ) {
    super(message)
    this.type = type
    this.statusCode = statusCode
    this.retryable = retryable
    this.userMessage = userMessage
    this.name = 'UploadError'
  }

  static fromAxiosError(error: any, chunkIndex?: number): UploadError {
    const chunkMsg = chunkIndex !== undefined ? `分片 ${chunkIndex + 1}` : '文件'
    
    if (error.code === 'ECONNABORTED' || error.message?.includes('timeout')) {
      return new UploadError(
        UploadErrorType.TIMEOUT_ERROR,
        `Upload timeout: ${error.message}`,
        `${chunkMsg}上传超时，请检查网络连接`,
        error.response?.status,
        true
      )
    }
    
    if (!error.response) {
      return new UploadError(
        UploadErrorType.NETWORK_ERROR,
        `Network error: ${error.message}`,
        `网络连接失败，请检查网络状态`,
        undefined,
        true
      )
    }

    const status = error.response.status
    const data = error.response.data

    if (status >= 500) {
      return new UploadError(
        UploadErrorType.SERVER_ERROR,
        `Server error ${status}: ${data?.message || error.message}`,
        `服务器暂时不可用 (${status})，正在重试...`,
        status,
        true
      )
    } else if (status === 413) {
      return new UploadError(
        UploadErrorType.FILE_ERROR,
        `File too large: ${data?.message || error.message}`,
        `${chunkMsg}过大，请选择较小的文件`,
        status,
        false
      )
    } else if (status === 401 || status === 403) {
      return new UploadError(
        UploadErrorType.SERVER_ERROR,
        `Authorization failed: ${data?.message || error.message}`,
        `认证失败，请重新登录`,
        status,
        false
      )
    } else {
      return new UploadError(
        UploadErrorType.SERVER_ERROR,
        `HTTP ${status}: ${data?.message || error.message}`,
        `上传失败 (${status})，${data?.message || '未知错误'}`,
        status,
        status >= 400 && status < 500 ? false : true
      )
    }
  }

  static fromGenericError(error: any, context: string = ''): UploadError {
    if (error instanceof UploadError) {
      return error
    }
    
    const message = error.message || String(error)
    if (message.includes('memory') || message.includes('Memory')) {
      return new UploadError(
        UploadErrorType.MEMORY_ERROR,
        `Memory error in ${context}: ${message}`,
        `内存不足，请关闭其他程序或选择较小的文件`,
        undefined,
        false
      )
    }
    
    return new UploadError(
      UploadErrorType.FILE_ERROR,
      `${context} error: ${message}`,
      `文件处理出错: ${message}`,
      undefined,
      false
    )
  }
}

// 进度详情接口
interface UploadProgress {
  uploadedBytes: number
  totalBytes: number
  percentage: number
  speed: number  // bytes per second
  remainingTime: number  // seconds
  activeChunks: number
  completedChunks: number
  totalChunks: number
  lastError?: UploadError
  stage: 'preparing' | 'hashing' | 'uploading' | 'completing' | 'completed' | 'error'
}

const progressMutex = createMutex()

// 智能重试函数，支持服务器重启检测
const retryWithBackoff = async <T>(
  fn: () => Promise<T>,
  maxRetries: number = RETRY_CONFIG.maxRetries,
  delay: number = RETRY_CONFIG.retryDelay,
  context: string = 'operation'
): Promise<T> => {
  const healthChecker = ServerHealthChecker.getInstance()
  let lastError: Error
  
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error as Error
      
      // 如果是最后一次重试，直接抛出错误
      if (i === maxRetries) {
        throw lastError
      }

      // 检查是否是服务器相关错误
      const isServerError = error instanceof UploadError && 
        (error.type === UploadErrorType.SERVER_ERROR || error.type === UploadErrorType.NETWORK_ERROR)
      
      if (isServerError && error instanceof UploadError) {
        // 标记服务器可能离线
        healthChecker.markServerOffline()
        
        // 检查服务器状态
        const isServerHealthy = await healthChecker.isServerHealthy()
        
        if (!isServerHealthy) {
          console.log(`服务器似乎离线，等待恢复... (${context}, 重试 ${i + 1}/${maxRetries})`)
          
          // 等待服务器恢复，使用更长的等待时间
          const recovered = await healthChecker.waitForServerRecovery(30000)
          
          if (!recovered) {
            // 服务器恢复失败，但还有重试机会，继续重试
            console.warn(`服务器恢复失败，继续重试 (${context})`)
          } else {
            console.log(`服务器已恢复，继续上传 (${context})`)
          }
        }
      }
      
      // 计算延迟时间，对服务器错误使用更长的延迟
      let waitTime = delay * Math.pow(RETRY_CONFIG.backoffMultiplier, i)
      if (isServerError) {
        waitTime = Math.max(waitTime, RETRY_CONFIG.serverHealthCheckDelay)
      }
      waitTime = Math.min(waitTime, RETRY_CONFIG.maxDelay)
      
      console.log(`${context} 失败，${waitTime/1000}秒后重试 (${i + 1}/${maxRetries}):`, 
        (error as any) instanceof UploadError ? (error as UploadError).userMessage : (error as Error).message)
      
      await new Promise(resolve => setTimeout(resolve, waitTime))
    }
  }
  throw lastError!
}

// 上传状态管理
interface UploadState {
  isPaused: boolean
  isCancelled: boolean
  totalBytes: number
  uploadedBytes: number
  completedChunks: number
  totalChunks: number
  activeChunks: number
  speed: number
  lastError?: UploadError
  onProgress?: (progress: UploadProgress) => void
}

export const sliceupload = async (
  uploadPath: string,
  file: File,
  setUpload: SetUpload,
  overwrite = false,
  asTask = false,
  uploadState?: UploadState,
): Promise<Error | undefined> => {
  let hashtype: string = HashType.Md5
  let slicehash: string[] = []
  let sliceupstatus: Uint8Array
  let ht: string[] = []

  // 初始化上传状态
  const state: UploadState = uploadState || {
    isPaused: false,
    isCancelled: false,
    totalBytes: file.size,
    uploadedBytes: 0,
    completedChunks: 0,
    totalChunks: 0,
    activeChunks: 0,
    speed: 0,
  }

  // 注册到上传队列
  uploadQueue.addUpload(uploadPath, state)

  // 清理函数
  let speedInterval: any
  const cleanup = () => {
    if (speedInterval) {
      clearInterval(speedInterval)
    }
    uploadQueue.removeUpload(uploadPath)
  }

  const dir = pathDir(uploadPath)

  //获取上传需要的信息
  const resp = await fsUploadInfo(dir)
  if (resp.code != 200) {
    cleanup()
    return new Error(`Upload info failed: ${resp.code} - ${resp.message}`)
  }

  // hash计算
  if (resp.data.hash_md5_need) {
    ht.push(HashType.Md5)
    hashtype = HashType.Md5
  }
  if (resp.data.hash_sha1_need) {
    ht.push(HashType.Sha1)
    hashtype = HashType.Sha1
  }
  if (resp.data.hash_md5_256kb_need) {
    ht.push(HashType.Md5256kb)
  }
  const hash = await calculateHash(file, ht)
  // 预上传
  const resp1 = await fsPreup(
    dir,
    file.name,
    file.size,
    hash,
    overwrite,
    asTask,
  )
  if (resp1.code != 200) {
    cleanup()
    return new Error(`Preup failed: ${resp1.code} - ${resp1.message}`)
  }
  
  // 设置总分片数
  state.totalChunks = resp1.data.slice_cnt
  
  if (resp1.data.reuse) {
    setUpload("progress", "100")
    setUpload("status", "success")
    setUpload("speed", "0")
    cleanup()
    return
  }
  //计算分片hash
  if (resp.data.slice_hash_need) {
    slicehash = await calculateSliceHash(file, resp1.data.slice_size, hashtype)
  }
  // 分片上传状态
  sliceupstatus = base64ToUint8Array(resp1.data.slice_upload_status)

  // 进度和速度统计
  let lastTimestamp = Date.now()
  let lastUploadedBytes = 0
  let completeFlag = false

  // 计算已上传的字节数（用于断点续传）
  for (let i = 0; i < resp1.data.slice_cnt; i++) {
    if (isSliceUploaded(sliceupstatus, i)) {
      state.uploadedBytes += Math.min(
        resp1.data.slice_size,
        state.totalBytes - i * resp1.data.slice_size,
      )
    }
  }

  // 上传分片的核心函数，带进度、速度统计、重试和暂停支持
  const uploadChunk = async (
    chunk: Blob,
    idx: number,
    slice_hash: string,
    task_id: string,
  ) => {
    // 检查是否被取消
    if (state.isCancelled) {
      throw new UploadError(
        UploadErrorType.CANCEL_ERROR,
        'Upload cancelled by user',
        '上传已取消',
        undefined,
        false
      )
    }

    // 检查是否暂停，等待恢复
    while (state.isPaused && !state.isCancelled) {
      await new Promise(resolve => setTimeout(resolve, 100))
    }

    const formData = new FormData()
    formData.append("task_id", task_id)
    formData.append("slice_hash", slice_hash)
    formData.append("slice_num", idx.toString())
    formData.append("slice", chunk)

    let oldTimestamp = Date.now()
    let oldLoaded = 0

    return retryWithBackoff(async () => {
      try {
        const resp: EmptyResp = await r.post("/fs/slice_upload", formData, {
          headers: {
            "File-Path": encodeURIComponent(dir),
            "Content-Type": "multipart/form-data",
            Password: password(),
          },
          onUploadProgress: async (progressEvent: any) => {
            if (!progressEvent.lengthComputable || state.isCancelled) {
              return
            }
            //获取锁
            const release = await progressMutex.acquire()
            try {
              const sliceuploaded = progressEvent.loaded - oldLoaded
              state.uploadedBytes += sliceuploaded
              oldLoaded = progressEvent.loaded
              
              // 更新完成的分片数（估算）
              state.completedChunks = Math.floor(state.uploadedBytes / (state.totalBytes / state.totalChunks))
              
              // 实时进度更新
              const progress = Math.min(100, ((state.uploadedBytes / state.totalBytes) * 100) | 0)
              setUpload("progress", progress)
              
            } finally {
              progressMutex.release()
            }
          },
        })

        if (resp.code != 200) {
          throw new UploadError(
            UploadErrorType.SERVER_ERROR,
            `Slice upload failed: ${resp.code} - ${resp.message}`,
            `分片 ${idx + 1} 上传失败: ${resp.message || '服务器错误'}`,
            resp.code,
            resp.code >= 500
          )
        }
        return resp
      } catch (err: any) {
        // 转换为结构化错误
        const uploadError = err instanceof UploadError 
          ? err 
          : UploadError.fromAxiosError(err, idx)
          
        // 记录最后的错误
        state.lastError = uploadError
        
        console.error(`Chunk ${idx + 1} upload failed:`, uploadError.userMessage)
        throw uploadError
      }
    }, RETRY_CONFIG.maxRetries, RETRY_CONFIG.retryDelay, `slice_${idx + 1}_upload`)
  }

  // 进度速度计算
  speedInterval = setInterval(() => {
    if (completeFlag || state.isCancelled) {
      clearInterval(speedInterval)
      return
    }

    const intervalLoaded = state.uploadedBytes - lastUploadedBytes
    if (intervalLoaded < 1000) {
      //进度太小，不更新
      return
    }
    const speed = intervalLoaded / ((Date.now() - lastTimestamp) / 1000)
    const complete = Math.min(100, ((state.uploadedBytes / state.totalBytes) * 100) | 0)
    setUpload("speed", speed)
    setUpload("progress", complete)
    lastTimestamp = Date.now()
    lastUploadedBytes = state.uploadedBytes
  }, 1000)

  // 开始计时
  lastTimestamp = Date.now()

  // 先上传第一个分片，slicehash全部用逗号拼接传递
  if (!isSliceUploaded(sliceupstatus, 0)) {
    const chunk = file.slice(0, resp1.data.slice_size)
    try {
      await uploadChunk(
        chunk,
        0,
        slicehash.length == 0 ? "" : slicehash.join(","),
        resp1.data.task_id,
      )
    } catch (err) {
      completeFlag = true
      setUpload("status", "error")
      setUpload("speed", 0)
      return err as Error
    }
    } else {
      state.uploadedBytes += Math.min(resp1.data.slice_size, state.totalBytes)
    }  // 后续分片并发上传
  const concurrentLimit = 3 // 固定3个并发
  const limit = pLimit(concurrentLimit)

  console.log(`File size: ${(file.size / 1024 / 1024).toFixed(2)}MB, using ${concurrentLimit} concurrent uploads`)

  const tasks: Promise<void>[] = []
  const errors: Error[] = []
  for (let i = 1; i < resp1.data.slice_cnt; i++) {
    if (!isSliceUploaded(sliceupstatus, i)) {
      const chunk = file.slice(
        i * resp1.data.slice_size,
        (i + 1) * resp1.data.slice_size,
      )
      tasks.push(
        limit(async () => {
          try {
            await uploadChunk(
              chunk,
              i,
              slicehash.length == 0 ? "" : slicehash[i],
              resp1.data.task_id,
            )
          } catch (err) {
            errors.push(err as Error)
          }
        }),
      )
    } else {
      state.uploadedBytes += Math.min(
        resp1.data.slice_size,
        state.totalBytes - i * resp1.data.slice_size,
      )
    }
  }
  await Promise.all(tasks)

  // 最终处理上传结果
  if (errors.length > 0) {
    setUpload(
      "progress",
      Math.min(100, ((state.uploadedBytes / state.totalBytes) * 100) | 0),
    )
    setUpload("status", "error")
    cleanup()
    
    // 返回最具代表性的错误
    const serverErrors = errors.filter(e => e instanceof UploadError && e.type === UploadErrorType.SERVER_ERROR)
    const networkErrors = errors.filter(e => e instanceof UploadError && e.type === UploadErrorType.NETWORK_ERROR)
    
    if (serverErrors.length > 0) {
      return serverErrors[0]
    } else if (networkErrors.length > 0) {
      return networkErrors[0]
    } else {
      return errors[0]
    }
  } else {
    if (!asTask) {
      setUpload("status", "backending")
    }
    
    try {
      const resp = await retryWithBackoff(
        () => FsSliceupComplete(dir, resp1.data.task_id),
        RETRY_CONFIG.maxRetries,
        RETRY_CONFIG.retryDelay,
        'upload_complete'
      )
      
      completeFlag = true
      cleanup()
      
      if (resp.code != 200) {
        return new UploadError(
          UploadErrorType.SERVER_ERROR,
          `Upload complete failed: ${resp.code} - ${resp.message}`,
          `上传完成确认失败: ${resp.message}`,
          resp.code,
          resp.code >= 500
        )
      } else if (resp.data.complete == 0) {
        return new UploadError(
          UploadErrorType.SERVER_ERROR,
          "slice missing, please reupload",
          "文件分片缺失，请重新上传",
          undefined,
          true
        )
      }
      
      //状态处理交给上层
      return
    } catch (error) {
      cleanup()
      return error instanceof UploadError 
        ? error 
        : UploadError.fromGenericError(error, 'upload_complete')
    }
  }
}

// 解码 base64 字符串为 Uint8Array
const base64ToUint8Array = (base64: string): Uint8Array => {
  const binary = atob(base64)
  const len = binary.length
  const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

// 判断第 idx 个分片是否已上传
const isSliceUploaded = (status: Uint8Array, idx: number): boolean => {
  //   const bytes = base64ToUint8Array(statusBase64)
  const byteIdx = Math.floor(idx / 8)
  const bitIdx = idx % 8
  if (byteIdx >= status.length) return false
  return (status[byteIdx] & (1 << bitIdx)) !== 0
}

// 上传队列管理
class UploadQueue {
  private static instance: UploadQueue
  private uploads: Map<string, UploadState> = new Map()

  static getInstance(): UploadQueue {
    if (!UploadQueue.instance) {
      UploadQueue.instance = new UploadQueue()
    }
    return UploadQueue.instance
  }

  addUpload(uploadPath: string, state: UploadState): void {
    this.uploads.set(uploadPath, state)
  }

  pauseUpload(uploadPath: string): void {
    const state = this.uploads.get(uploadPath)
    if (state) {
      state.isPaused = true
    }
  }

  resumeUpload(uploadPath: string): void {
    const state = this.uploads.get(uploadPath)
    if (state) {
      state.isPaused = false
    }
  }

  cancelUpload(uploadPath: string): void {
    const state = this.uploads.get(uploadPath)
    if (state) {
      state.isCancelled = true
    }
  }

  removeUpload(uploadPath: string): void {
    this.uploads.delete(uploadPath)
  }

  getUploadState(uploadPath: string): UploadState | undefined {
    return this.uploads.get(uploadPath)
  }

  getAllUploads(): Array<{path: string, state: UploadState}> {
    return Array.from(this.uploads.entries()).map(([path, state]) => ({path, state}))
  }
}

// 导出队列管理函数
export const uploadQueue = UploadQueue.getInstance()

export const pauseUpload = (uploadPath: string) => uploadQueue.pauseUpload(uploadPath)
export const resumeUpload = (uploadPath: string) => uploadQueue.resumeUpload(uploadPath)
export const cancelUpload = (uploadPath: string) => uploadQueue.cancelUpload(uploadPath)

// 导出错误类型和辅助函数
export { UploadError, UploadErrorType }
export type { UploadProgress }

// 导出服务器健康检查器
export const serverHealthChecker = ServerHealthChecker.getInstance()

// 获取上传详细信息的辅助函数
export const getUploadDetails = (uploadPath: string): {
  state?: UploadState,
  progress?: UploadProgress,
  errorMessage?: string
} => {
  const state = uploadQueue.getUploadState(uploadPath)
  if (!state) return {}
  
  const progress: UploadProgress = {
    uploadedBytes: state.uploadedBytes,
    totalBytes: state.totalBytes,
    percentage: Math.min(100, ((state.uploadedBytes / state.totalBytes) * 100) | 0),
    speed: state.speed,
    remainingTime: state.speed > 0 ? (state.totalBytes - state.uploadedBytes) / state.speed : 0,
    activeChunks: state.activeChunks,
    completedChunks: state.completedChunks,
    totalChunks: state.totalChunks,
    lastError: state.lastError,
    stage: state.isCancelled ? 'error' : 
           state.uploadedBytes >= state.totalBytes ? 'completed' : 'uploading'
  }
  
  return {
    state,
    progress,
    errorMessage: state.lastError?.userMessage
  }
}
