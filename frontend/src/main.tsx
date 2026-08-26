import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles/global.css'

// 全局未处理 Promise 拒绝捕获（v0.22.x）：异步错误不再无声消失，
// 统一走 console.error 便于排查（ErrorBoundary 仅覆盖渲染错误）。
window.addEventListener('unhandledrejection', (event) => {
  console.error('[Hertz] Unhandled promise rejection:', event.reason)
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
