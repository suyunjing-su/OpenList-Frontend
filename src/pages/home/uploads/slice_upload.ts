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

const progressMutex = createMutex()

export const sliceupload = async (
  uploadPath: string,
  file: File,
  setUpload: SetUpload,
  overwrite = false,
  asTask = false,
): Promise<Error | undefined> => {
  let hashtype: string = HashType.Md5
  let slicehash: string[] = []
  let sliceupstatus: Uint8Array
  let ht: string[] = []

  const dir = pathDir(uploadPath)

  //获取上传需要的信息
  const resp = await fsUploadInfo(dir)
  if (resp.code != 200) {
    return new Error(resp.message)
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
    return new Error(resp1.message)
  }
  if (resp1.data.reuse) {
    setUpload("progress", "100")
    setUpload("status", "success")
    setUpload("speed", "0")
    return
  }
  //计算分片hash
  if (resp.data.slice_hash_need) {
    slicehash = await calculateSliceHash(file, resp1.data.slice_size, hashtype)
  }
  // 分片上传状态
  sliceupstatus = base64ToUint8Array(resp1.data.slice_upload_status)

  // 进度和速度统计
  let uploadedBytes = 0
  let lastTimestamp = Date.now()
  let lastUploadedBytes = 0
  const totalSize = file.size
  let completeFlag = false

  // 上传分片的核心函数，带进度和速度统计
  const uploadChunk = async (
    chunk: Blob,
    idx: number,
    slice_hash: string,
    upload_id: number,
  ) => {
    const formData = new FormData()
    formData.append("upload_id", upload_id.toString())
    formData.append("slice_hash", slice_hash)
    formData.append("slice_num", idx.toString())
    formData.append("slice", chunk)

    let oldTimestamp = Date.now()
    let oldLoaded = 0

    const resp: EmptyResp = await r.post("/fs/slice_upload", formData, {
      headers: {
        "File-Path": encodeURIComponent(dir),
        "Content-Type": "multipart/form-data",
        Password: password(),
      },
      onUploadProgress: async (progressEvent) => {
        if (!progressEvent.lengthComputable) {
          return
        }
        //获取锁
        const release = await progressMutex.acquire()
        try {
          const sliceuploaded = progressEvent.loaded - oldLoaded
          uploadedBytes += sliceuploaded
          oldLoaded = progressEvent.loaded
        } finally {
          progressMutex.release()
        }
      },
    })

    if (resp.code != 200) {
      throw new Error(resp.message)
    }
  }

  // 进度速度计算
  let speedInterval = setInterval(() => {
    if (completeFlag) {
      clearInterval(speedInterval)
      return
    }

    const intervalLoaded = uploadedBytes - lastUploadedBytes
    if (intervalLoaded < 1000) {
      //进度太小，不更新
      return
    }
    const speed = intervalLoaded / ((Date.now() - lastTimestamp) / 1000)
    const complete = Math.min(100, ((uploadedBytes / file.size) * 100) | 0)
    setUpload("speed", speed)
    setUpload("progress", complete)
    lastTimestamp = Date.now()
    lastUploadedBytes = uploadedBytes
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
        resp1.data.upload_id,
      )
    } catch (err) {
      completeFlag = true
      setUpload("status", "error")
      setUpload("speed", 0)
      return err as Error
    }
  } else {
    uploadedBytes += Math.min(resp1.data.slice_size, totalSize)
  }

  // 后续分片并发上传，限制并发数为3，后续也可以通过fsUploadInfo接口获取配置
  const limit = pLimit(3)

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
              resp1.data.upload_id,
            )
          } catch (err) {
            errors.push(err as Error)
          }
        }),
      )
    } else {
      uploadedBytes += Math.min(
        resp1.data.slice_size,
        totalSize - i * resp1.data.slice_size,
      )
    }
  }
  await Promise.all(tasks)

  // 最终处理上传结果
  if (errors.length > 0) {
    setUpload(
      "progress",
      Math.min(100, ((uploadedBytes / totalSize) * 100) | 0),
    )
    return errors[0]
  } else {
    if (!asTask) {
      setUpload("status", "backending")
    }
    const resp = await FsSliceupComplete(dir, resp1.data.upload_id)
    completeFlag = true
    if (resp.code != 200) {
      return new Error(resp.message)
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
