/**
 * ssh2 没有从主入口导出 SFTP 协议类（`module.exports` 里只有 Client / Server / utils），
 * 但它的实现本身是可复用的 —— 我们用它把一条 exec 通道包成 SFTP 客户端，
 * 这样才能跑 `sudo sftp-server`（子系统请求（subsystem: sftp）没法带 sudo）。
 */
declare module 'ssh2/lib/protocol/SFTP.js' {
    import { EventEmitter } from 'node:events';

    export class SFTP extends EventEmitter {
        constructor(client: any, chanInfo: any, cfg?: Record<string, unknown>);
        push(data: Buffer | null): void;
        _init(): void;
        end(): void;
        destroy(): void;
    }
}
