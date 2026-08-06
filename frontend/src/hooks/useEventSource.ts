import { useEffect, useRef } from 'react'

/**
 * SSE 订阅 hook：断线自动重连（指数退避，最长 15s）。
 * 后端重启/休眠唤醒导致连接中断时，事件流能自行恢复
 * （AXIOM §22.2 优雅降级）。
 */
export function useEventSource(url: string | null, onEvent: (ev: MessageEvent<string>) => void) {
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent

  useEffect(() => {
    if (!url) return
    let source: EventSource | null = null
    let closed = false
    let retry = 0
    let timer: ReturnType<typeof setTimeout> | null = null

    const schedule = () => {
      const delay = Math.min(15000, 1000 * 2 ** retry)
      retry += 1
      timer = setTimeout(connect, delay)
    }

    const connect = () => {
      if (closed) return
      source?.close()
      source = new EventSource(url)
      source.onmessage = (ev) => {
        retry = 0
        onEventRef.current(ev)
      }
      source.onerror = () => {
        if (closed) return
        schedule()
      }
    }

    connect()
    return () => {
      closed = true
      if (timer) clearTimeout(timer)
      source?.close()
    }
  }, [url])
}
