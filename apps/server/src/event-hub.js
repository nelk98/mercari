/**
 * 极简 SSE 广播：供抓取进度、列表更新等推送到已连接的客户端。
 */
export const createEventHub = () => {
  const clients = new Set()

  const broadcast = (event, payload) => {
    const data = JSON.stringify(payload ?? {})
    const msg = `event: ${event}\ndata: ${data}\n\n`
    for (const res of [...clients]) {
      try {
        if (!res.writableEnded) res.write(msg)
      } catch (_) {
        clients.delete(res)
      }
    }
  }

  const subscribe = (res) => {
    clients.add(res)
    return () => clients.delete(res)
  }

  setInterval(() => {
    for (const res of [...clients]) {
      try {
        if (!res.writableEnded) res.write(': keepalive\n\n')
      } catch (_) {
        clients.delete(res)
      }
    }
  }, 25000)

  return { subscribe, broadcast }
}
