import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildDockerExecCommand,
  buildShellProbeCommand,
  parseShellProbeOutput,
} from '../src/docker/exec-command.ts';

/**
 * 「进入容器」的命令生成 + shell 探测。
 *
 * 这块最容易出的错是**探测脚本的 shell 语法**（多行 if/then/for 拼错、
 * 试探不存在的 shell 时 stderr 漏到终端），所以除了单测字符串，还真跑一遍脚本。
 */

// --- 命令模板 ---

test('buildDockerExecCommand：空模板 → 用探测到的 shell', () => {
  assert.equal(
    buildDockerExecCommand({ containerId: 'abc123', shell: 'bash' }),
    'docker exec -it abc123 bash',
  );
});

test('buildDockerExecCommand：auto 与空等价', () => {
  assert.equal(
    buildDockerExecCommand({ containerId: 'abc123', template: 'AUTO', shell: 'ash' }),
    'docker exec -it abc123 ash',
  );
});

test('buildDockerExecCommand：探测不到 shell 时退回 sh', () => {
  assert.equal(
    buildDockerExecCommand({ containerId: 'abc123', template: '', shell: '' }),
    'docker exec -it abc123 sh',
  );
});

test('buildDockerExecCommand：只填程序名 → 拼到容器 ID 后面', () => {
  assert.equal(
    buildDockerExecCommand({ containerId: 'abc123', template: 'bash' }),
    'docker exec -it abc123 bash',
  );
  assert.equal(
    buildDockerExecCommand({ containerId: 'abc123', template: '  powershell  ' }),
    'docker exec -it abc123 powershell',
  );
});

test('buildDockerExecCommand：含 {id} 的完整模板原样替换（可加 -u 等参数）', () => {
  assert.equal(
    buildDockerExecCommand({
      containerId: 'abc123',
      template: 'docker exec -it -u root {id} bash',
    }),
    'docker exec -it -u root abc123 bash',
  );
  assert.equal(
    buildDockerExecCommand({
      containerId: 'abc123',
      containerName: 'web-1',
      template: 'docker exec -it {name} sh',
    }),
    'docker exec -it web-1 sh',
  );
});

test('buildDockerExecCommand：{name} 缺省时退回容器 ID', () => {
  assert.equal(
    buildDockerExecCommand({ containerId: 'abc123', template: 'docker exec -it {name} sh' }),
    'docker exec -it abc123 sh',
  );
});

test('buildDockerExecCommand：{shell} 走探测结果，大小写混写也替换', () => {
  assert.equal(
    buildDockerExecCommand({
      containerId: 'abc123',
      template: 'docker exec -it {id} {shell}',
      shell: 'ash',
    }),
    'docker exec -it abc123 ash',
  );
});

test('buildDockerExecCommand：替换是全局的（{id} 出现多次）', () => {
  assert.equal(
    buildDockerExecCommand({
      containerId: 'abc123',
      template: 'docker exec -it {id} sh -c "echo {id}"',
    }),
    'docker exec -it abc123 sh -c "echo abc123"',
  );
});

// --- 探测结果解析 ---

test('parseShellProbeOutput：解析 shell / os', () => {
  assert.deepEqual(
    parseShellProbeOutput('NEXUS_OS=linux\nNEXUS_SHELL=bash\n'),
    { shell: 'bash', os: 'linux' },
  );
});

test('parseShellProbeOutput：一个候选都没有 → shell 为空，os 回退 unknown', () => {
  assert.deepEqual(parseShellProbeOutput('NEXUS_OS=\nNEXUS_SHELL=\n'), { shell: '', os: 'unknown' });
  assert.deepEqual(parseShellProbeOutput(''), { shell: '', os: 'unknown' });
});

test('parseShellProbeOutput：混入 docker 报错噪音也能取到值', () => {
  const noisy = 'Error: No such container: abc\nNEXUS_OS=linux\nNEXUS_SHELL=ash\n';
  assert.deepEqual(parseShellProbeOutput(noisy), { shell: 'ash', os: 'linux' });
});

// --- 真跑一遍探测脚本（用一个假的 docker 模拟容器里到底有哪些 shell） ---

/** 造一个只认指定 shell 的假 docker：inspect 返回 os，exec 只在候选命中时退出 0 */
function makeFakeDockerBin(dir: string, available: string[], os = 'linux') {
  const script = [
    '#!/bin/sh',
    'if [ "$1" = "inspect" ]; then echo "%OS%"; exit 0; fi',
    'if [ "$1" = "exec" ]; then',
    '  # $2=容器 $3=程序 $4=参数 $5=脚本',
    '  case " %AVAILABLE% " in',
    '    *" $3 "*) exit 0 ;;',
    '    *) echo "OCI runtime exec failed: exec failed: executable file not found" >&2; exit 126 ;;',
    '  esac',
    'fi',
    'exit 1',
  ].join('\n')
    .replace('%OS%', os)
    .replace('%AVAILABLE%', available.join(' '));
  const bin = path.join(dir, 'docker');
  fs.writeFileSync(bin, script, { mode: 0o755 });
  return bin;
}

/** Git Bash 才有 sh；没有就跳过（Windows 裸环境） */
function findSh(): string | null {
  for (const p of ['C:/Program Files/Git/bin/sh.exe', 'C:/Program Files/Git/usr/bin/sh.exe', '/bin/sh', '/usr/bin/sh']) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const SH = findSh();
const probe = SH ? buildShellProbeCommand('fakecontainer1234') : '';

test('探测脚本：语法合法（sh -n）', { skip: SH ? false : '没有可用的 sh' }, () => {
  assert.doesNotThrow(() => execFileSync(SH!, ['-n', '-c', probe], { stdio: 'pipe' }));
});

for (const [label, available, expected] of [
  ['Debian：有 bash', ['bash', 'sh'], 'bash'],
  ['Alpine：只有 ash', ['ash', 'sh'], 'ash'],
  ['只有 sh', ['sh'], 'sh'],
  ['distroless：一个都没有', [], ''],
] as const) {
  test(`探测脚本真跑：${label} → ${expected || '(空)'}`, { skip: SH ? false : '没有可用的 sh' }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-docker-'));
    makeFakeDockerBin(dir, available as unknown as string[]);
    try {
      const stdout = execFileSync(SH!, ['-c', probe], {
        env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH || ''}` },
        encoding: 'utf8',
      });
      assert.equal(parseShellProbeOutput(stdout).shell, expected as string);
      assert.equal(parseShellProbeOutput(stdout).os, 'linux');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('探测脚本真跑：Windows 容器优先 powershell', { skip: SH ? false : '没有可用的 sh' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-docker-'));
  makeFakeDockerBin(dir, ['powershell'], 'windows');
  try {
    const stdout = execFileSync(SH!, ['-c', probe], {
      env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH || ''}` },
      encoding: 'utf8',
    });
    const parsed = parseShellProbeOutput(stdout);
    assert.equal(parsed.shell, 'powershell');
    assert.equal(parsed.os, 'windows');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('探测脚本：试探失败的 stderr 不外泄（stdout 只有两行结果）', { skip: SH ? false : '没有可用的 sh' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-docker-'));
  makeFakeDockerBin(dir, ['ash']);
  try {
    const stdout = execFileSync(SH!, ['-c', probe], {
      env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH || ''}` },
      encoding: 'utf8',
    });
    assert.equal(stdout.trim().split('\n').length, 2);
    assert.ok(!stdout.includes('executable file not found'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
