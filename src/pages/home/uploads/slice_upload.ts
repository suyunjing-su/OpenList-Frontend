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
  maxRetries: 3,
  retryDelay: 1000, // 1秒
  backoffMultiplier: 2, // 指数退避
}

// 大文件优化配置
const MEMORY_OPTIMIZATION = {
  largeFileThreshold: 100 * 1024 * 1024, // 100MB
  maxConcurrentSlices: 2, // 大文件时减少并发
  chunkReadSize: 64 * 1024, // 64KB 分块读取
}

const progressMutex = createMutex()

// 重试函数
const retryWithBackoff = async <T>(
  fn: () => Promise<T>,
  maxRetries: number = RETRY_CONFIG.maxRetries,
  delay: number = RETRY_CONFIG.retryDelay
): Promise<T> => {
  let lastError: Error
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error as Error
      if (i === maxRetries) {
        throw lastError
      }
      // 指数退避延迟
      const waitTime = delay * Math.pow(RETRY_CONFIG.backoffMultiplier, i)
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
      throw new Error("Upload cancelled by user")
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
          } finally {
            progressMutex.release()
          }
        },
      })

      if (resp.code != 200) {
        throw new Error(`Slice upload failed: ${resp.code} - ${resp.message}`)
      }
      return resp
    })
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
    }  // 后续分片并发上传，根据文件大小动态调整并发数
  const isLargeFile = file.size > MEMORY_OPTIMIZATION.largeFileThreshold
  const concurrentLimit = isLargeFile ? MEMORY_OPTIMIZATION.maxConcurrentSlices : 3
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
    cleanup()
    return errors[0]
  } else {
    if (!asTask) {
      setUpload("status", "backending")
    }
    const resp = await FsSliceupComplete(dir, resp1.data.task_id)
    completeFlag = true
    cleanup()
    if (resp.code != 200) {
      return new Error(`Upload complete failed: ${resp.code} - ${resp.message}`)
    } else if (resp.data.complete == 0) {
      return new Error("slice missing, please reupload")
    }
    //状态处理交给上层
    return
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
