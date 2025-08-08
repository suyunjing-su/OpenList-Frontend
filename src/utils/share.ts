import { ShareInfo } from "~/types"
import { base_path } from "."

const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"

export const randomPwd = () => {
  let arr = []
  arr.length = 5
  for (let i = 0; i < arr.length; i++) {
    arr[i] = letters[Math.floor(Math.random() * letters.length)]
  }
  return arr.join("")
}

export const makeTemplateData = (
  share: ShareInfo,
  other?: { [k: string]: any },
) => {
  return {
    base_url: location.origin + base_path,
    ...share,
    ...other,
  }
}
