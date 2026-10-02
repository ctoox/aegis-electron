import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
// 第二份样式表: 健康检查页 / 设置页 / toast / 导入预览 (后加载 → 覆盖优先级更高)
import "./styles-pages.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
