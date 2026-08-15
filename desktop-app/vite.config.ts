import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// 渲染进程构建配置：开发用 Vite dev server（Electron 加载 localhost），
// 生产打包输出到 dist/，Electron 加载 file://dist/index.html。
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    // antd 全家桶 + icons 作为独立 vendor chunk，体积约 730KB（桌面端本地加载，可接受）
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        // 函数式分包：按 node_modules 实际路径精确分组，
        // 修复对象式 manualChunks 中 react/react-dom 只捕获入口门面（产出 0.03KB 空 chunk）的问题。
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/scheduler/')) {
            return 'react-vendor';
          }
          if (
            id.includes('/antd/') ||
            id.includes('/@ant-design/') ||
            id.includes('/@rc-component/') ||
            id.includes('/rc-')
          ) {
            return 'antd-vendor';
          }
          // 其余（dayjs、classnames、zustand 等）交回 Rollup 自动分配；
          // mammoth 通过动态 import 单独成 chunk，按需加载。
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: false,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
});
