// Agent 基类 — 通过 opencode CLI（opencode run）调用 LLM
// 使用 CLI 而非 HTTP API，因为 opencode web 的 HTTP API 会路由到 opencode-go/glm-5.2
// 该模型周限额已耗尽；CLI 方式能正确解析 opencode 默认模型

import { execSync } from 'child_process';
import type { ModelConfig } from '../types/config.js';

export interface AgentOptions {
  name: string;
  /** null/缺省 = 不传 -m，继承 opencode CLI 默认模型（opencode.jsonc 的 model） */
  model?: ModelConfig | null;
  systemPrompt?: string;
  /** LLM 调用超时毫秒（默认 300s），单次 prompt() 超过此值抛出 AgentTimeoutError */
  timeoutMs?: number;
}

/** Agent 超时专用错误，便于调用方区分超时 vs 其他异常 */
export class AgentTimeoutError extends Error {
  constructor(agentName: string, timeoutMs: number) {
    super(`Agent ${agentName}: LLM call timed out after ${Math.round(timeoutMs / 1000)}s`);
    this.name = 'AgentTimeoutError';
  }
}

export class BaseAgent {
  protected name: string;
  protected model: ModelConfig | null;
  protected systemPrompt: string;
  protected timeoutMs: number;

  constructor(options: AgentOptions) {
    this.name = options.name;
    this.model = options.model ?? null;
    this.systemPrompt = options.systemPrompt ?? '';
    this.timeoutMs = options.timeoutMs ?? 300_000;
  }

   /** 调用 opencode run CLI 并返回 LLM 输出文本 */
  private callOpencodeRun(promptText: string, system?: string): string {
    const fullPrompt = system ? `${system}\n\n${promptText}` : promptText;
    // 未配置模型时不传 -m，让 opencode 使用自身默认模型（单一来源：opencode.jsonc）
    const modelArg = this.model ? ` -m ${this.model.providerID}/${this.model.modelID}` : '';

    // 通过 stdin 传 prompt，避免 shell 转义和命令行长度限制
    // 使用完整路径避免 cron 环境下 PATH 缺失
    const cmd = `/usr/local/bin/opencode run${modelArg} 2>/dev/null`;

    let result: string;
    try {
      result = execSync(cmd, {
        input: fullPrompt,
        timeout: this.timeoutMs,
        maxBuffer: 1024 * 1024 * 10, // 10MB
        shell: '/bin/bash',
        encoding: 'utf-8' as const,
      });
    } catch (err: unknown) {
      // 将 Node.js child_process 超时错误转为 AgentTimeoutError
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
        throw new AgentTimeoutError(this.name, this.timeoutMs);
      }
      throw err;
    }

    const output = result || '';

    // 清理输出：去掉 ANSI 转义、空行、> 提示行、timestamp 行
    const lines = output.split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0)
      .filter(l => !l.startsWith('timestamp='))
      .filter(l => !l.startsWith('> '))
      .filter(l => !l.startsWith('Usage:'));

    return lines.join('\n');
  }

  /** 发送 prompt，获取文本回复 */
  async prompt(content: string): Promise<string> {
    const text = this.callOpencodeRun(content, this.systemPrompt || undefined);
    return text.trim();
  }

  /** 发送 prompt，获取结构化 JSON 输出 */
  async structuredPrompt<T>(content: string, _schema: Record<string, unknown>): Promise<T> {
    const jsonInstruction = `\n\n请严格按照上述 JSON 格式输出，不要包含任何其他文本。直接输出 JSON，不要用 markdown 代码块包裹。JSON中不要包含tab、换行等控制字符。`;
    const fullContent = content + jsonInstruction;

    const text = await this.prompt(fullContent);

    return this.parseJSON<T>(text, content);
  }

  /** JSON 解析含多级修复（self-heal） */
  private async parseJSON<T>(raw: string, _originalContent?: string): Promise<T> {
    function tryParse(s: string): T | null {
      try { return JSON.parse(s) as T; } catch { return null; }
    }

    function deepClean(s: string): string {
      let r = s
        .replace(/[\x00-\x1f]/g, ' ')
        .replace(/\\\n/g, '')
        .replace(/\\t/g, ' ')
        .replace(/\u201c/g, '"').replace(/\u201d/g, '"')
        .replace(/\u2018/g, "'").replace(/\u2019/g, "'")
        .replace(/，/g, ',')
        .replace(/,(\s*[}\]])/g, '$1')
        .replace(/\s{2,}/g, ' ')
        .trim();
      r = r.replace(/\\([^"\\\/bfnrtu])/g, (_, c) => c);
      return r;
    }

    function getParseErrorDetail(s: string): string {
      try { JSON.parse(s); return '无错误'; }
      catch (e) {
        const msg = String(e);
        const m = msg.match(/(?:position|at)\s*(\d+)/i);
        if (m) {
          const p = parseInt(m[1], 10);
          const start = Math.max(0, p - 40);
          const end = Math.min(s.length, p + 40);
          return `位置 ${p}: ...${JSON.stringify(s.slice(start, end))}...`;
        }
        return msg.slice(0, 200);
      }
    }

    // 1. 深度清洁后直接解析
    let cleaned = deepClean(raw);
    let parsed = tryParse(cleaned);
    if (parsed) return parsed;

    // 2. markdown 代码块提取
    const cb = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (cb) {
      parsed = tryParse(deepClean(cb[1]));
      if (parsed) return parsed;
    }

    // 3. 最外层 JSON 对象提取 + 状态机修复
    const jm = cleaned.match(/\{[\s\S]*\}/);
    if (jm) {
      parsed = tryParse(jm[0]);
      if (parsed) return parsed;

      // 状态机修复字符串内未转义引号
      let fixed = '';
      let inStr = false;
      let esc = false;
      for (let i = 0; i < jm[0].length; i++) {
        const ch = jm[0][i];
        if (esc) { fixed += ch; esc = false; continue; }
        if (ch === '\\') { fixed += ch; esc = true; continue; }
        if (ch === '"') {
          if (inStr) {
            const nextNS = jm[0].slice(i + 1).match(/\S/);
            const next = nextNS ? nextNS[0] : '';
            if (next === ',' || next === '}' || next === ']' || next === ':' || next === '') {
              inStr = false; fixed += ch;
            } else { fixed += '\\"'; }
          } else { inStr = true; fixed += ch; }
          continue;
        }
        fixed += ch;
      }
      parsed = tryParse(fixed);
      if (parsed) return parsed;
    }

    const diag = getParseErrorDetail(cleaned);

    // 4. 最后兜底：回喂 LLM 修复
    try {
      const repairPrompt =
        `你上一条回复不是合法 JSON,JSON.parse 失败于 ${diag}。\n` +
        `请只输出修复后的完整 JSON(以 { 开头,以 } 结尾),不要任何解释、不要 markdown 代码块。\n` +
        `常见问题:数组元素缺少引号包裹(如数字+中文混合 -8.27%月跌幅)、字段名未加引号、字符串内部出现未转义的双引号。\n` +
        `请确保所有字符串值都用双引号包裹,字符串内的双引号用 \\" 转义。\n\n` +
        `原始输出(需要修复):\n${raw}`;
      const repairedText = await this.prompt(repairPrompt);
      const repairedClean = deepClean(repairedText);
      parsed = tryParse(repairedClean);
      if (parsed) return parsed;

      const rcb = repairedClean.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (rcb) { parsed = tryParse(deepClean(rcb[1])); if (parsed) return parsed; }
      const rjm = repairedClean.match(/\{[\s\S]*\}/);
      if (rjm) { parsed = tryParse(rjm[0]); if (parsed) return parsed; }
    } catch {
      // self-heal 自身失败就放弃
    }

    throw new Error(
      `Agent ${this.name}: Failed to parse structured output.\n` +
      `  JSON解析错误: ${diag}\n` +
      `  前300字符: ${raw.slice(0, 300)}`
    );
  }

  async cleanup(): Promise<void> {
    // CLI 模式无需清理
  }
}
