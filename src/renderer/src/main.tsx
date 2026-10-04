import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import FillPanel from "./FillPanel";
import "./styles.css";
// 第二份样式表: 健康检查页 / 设置页 / toast / 导入预览 / 快速填充面板
// (后加载 → 覆盖优先级更高)
import "./styles-pages.css";

/**
 * 快速填充面板是同一个 bundle 的另一个入口（`index.html#/fill`）。
 * 不新开一个 vite entry —— 那样就得把设计 token 再拷一份，
 * 而面板的观感必须和主窗口是同一个人做的。
 */
const isFillPanel = window.location.hash.startsWith("#/fill");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{isFillPanel ? <FillPanel /> : <App />}</React.StrictMode>,
);
