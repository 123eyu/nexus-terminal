// noVNC 不发布类型声明，这里只声明我们实际用到的部分（RFB 类），
// 避免整份 client API 都要手写一遍。
declare module '@novnc/novnc' {
  const RFB: any;
  export default RFB;
}
