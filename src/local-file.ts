export function localFilePath(href: string): string | undefined {
  try {
    const url = new URL(href)
    if (url.protocol !== 'file:' || (url.hostname !== '' && url.hostname !== 'localhost')) return undefined
    let path = decodeURIComponent(url.pathname).replace(/\0/g, '').replace(/\\/g, '/')
    if (/^\/[a-zA-Z]:\//.test(path)) path = path.slice(1)
    if (!/^[a-zA-Z]:\//.test(path) && !path.startsWith('/')) return undefined
    if (path.split('/').includes('..')) return undefined
    return path
  } catch { return undefined }
}
