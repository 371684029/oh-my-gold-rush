import { describe, it, expect } from 'vitest';
import { parseSinaQuoteLine } from '../src/data/live-anchors';
import { parsePbocReservesFromText } from '../src/data/pboc-grabber';
import { isValidMarketNumber, isMissingPrice, parseMarketData } from '../src/schemas/market';
import { forwardFillCloses } from '../src/utils/price-series';
import type { GoldPriceRecord } from '../src/types/market';

describe('isValidMarketNumber / isMissingPrice', () => {
  it('拒绝 0 与 NaN', () => {
    expect(isValidMarketNumber(0)).toBe(false);
    expect(isValidMarketNumber(NaN)).toBe(false);
    expect(isValidMarketNumber(null)).toBe(false);
  });

  it('接受正金价与负 TIPS', () => {
    expect(isValidMarketNumber(4035.8)).toBe(true);
    expect(isValidMarketNumber(-0.5)).toBe(true);
  });

  it('N/A 占位为缺失', () => {
    expect(isMissingPrice({ value: 0, change: 0, source: 'N/A', sourceGrade: 'C', verifiedAt: '' })).toBe(true);
    expect(isMissingPrice({ value: 4000, change: 0, source: 'gold-api', sourceGrade: 'A', verifiedAt: '' })).toBe(false);
  });
});

describe('parseMarketData 零值', () => {
  it('LLM 输出 0 价不作为有效报价', () => {
    const data = parseMarketData({
      timestamp: '2026-07-15T00:00:00Z',
      london: { price: { value: 0, source: 'x', sourceGrade: 'B', verifiedAt: 't' } },
      shanghai: { price: { value: 0, source: 'x', sourceGrade: 'B', verifiedAt: 't' } },
      etf: { nav: { value: 0, source: 'x', sourceGrade: 'B', verifiedAt: 't' } },
      dollarIndex: { value: { value: 0, source: 'x', sourceGrade: 'B', verifiedAt: 't' } },
      usTreasury: {
        yield10y: { value: 0, source: 'x', sourceGrade: 'B', verifiedAt: 't' },
        tips: { value: 0, source: 'x', sourceGrade: 'B', verifiedAt: 't' },
      },
    });
    expect(isMissingPrice(data.london.price)).toBe(true);
    expect(isMissingPrice(data.dollarIndex.value)).toBe(true);
  });
});

describe('forwardFillCloses 跳过 0', () => {
  it('0 不污染序列，沿用前值', () => {
    const records = [
      { date: '2026-07-10', londonClose: 4100 },
      { date: '2026-07-11', londonClose: 0 },
      { date: '2026-07-12', londonClose: null },
      { date: '2026-07-13', londonClose: 4050 },
    ] as GoldPriceRecord[];
    const closes = forwardFillCloses(records);
    expect(closes).toEqual([4100, 4100, 4100, 4050]);
    // 相对 MA 不会因 0 变成 -100%
    const last = closes[closes.length - 1];
    const ma = closes.reduce((a, b) => a + b, 0) / closes.length;
    const dev = ((last - ma) / ma) * 100;
    expect(Math.abs(dev)).toBeLessThan(50);
  });
});

describe('parsePbocReservesFromText', () => {
  it('解析吨数', () => {
    const r = parsePbocReservesFromText('中国央行黄金储备 2292 吨，连续增持');
    expect(r?.tons).toBe(2292);
  });

  it('解析万盎司并换算吨', () => {
    const r = parsePbocReservesFromText('官方黄金储备 7380 万盎司');
    expect(r).not.toBeNull();
    expect(r!.tons).toBeGreaterThan(2000);
    expect(r!.tons).toBeLessThan(3000);
  });

  it('解析东财风格：万盎司+吨+环比+连续月', () => {
    const r = parsePbocReservesFromText(
      '中国6月末黄金储备报7544万盎司(约2346.446吨)，环比增加48万盎司(约14.93吨)。为连续第20个月增持黄金。',
    );
    expect(r).not.toBeNull();
    expect(r!.tons).toBeCloseTo(2346.446, 1);
    expect(r!.changeTons).toBeCloseTo(14.93, 1);
    expect(r!.consecutiveMonths).toBe(20);
  });
});

describe('parseGldHoldingsFromText', () => {
  // 动态 import 避免循环；直接从 etf-grabber 测
  it('解析 SPDR 持仓吨数与日变化', async () => {
    const { parseGldHoldingsFromText } = await import('../src/data/etf-grabber');
    const r = parseGldHoldingsFromText(
      '截至7月10日，全球最大黄金ETF——SPDR Gold Trust持仓较前一日减少3.199吨，当前持仓量为1002.449吨。',
    );
    expect(r).not.toBeNull();
    expect(r!.tons).toBeCloseTo(1002.449, 2);
    expect(r!.change).toBeCloseTo(-3.199, 2);
    expect(r!.asOf).toMatch(/-07-10$/);
  });
});

describe('parseSinaQuoteLine — 新浪行情行解析（零 LLM 直连锚定）', () => {
  it('SGE 贵金属格式（gds_AU9999 上海金）：现价第 0 位，昨收第 7 位', () => {
    const q = parseSinaQuoteLine(
      'var hq_str_gds_AU9999="890.75,0,890.61,890.75,896.30,889.00,14:07:19,907.32,890.50,1129200,150.00,550.00,2026-10-08,99黄金";',
    );
    expect(q).toEqual({ price: 890.75, prev: 907.32 });
  });

  it('期货格式（hf_XAU）：现价第 0 位，昨收第 7/8 位兜底', () => {
    const q = parseSinaQuoteLine(
      'var hq_str_hf_XAU="4118.77,4110.680,4118.77,4119.12,4143.16,4103.25,14:07:00,4110.68,4115.25,0,0,0,2026-10-08,伦敦金现货黄金";',
    );
    expect(q).toEqual({ price: 4118.77, prev: 4110.68 });
  });

  it('A股/ETF 格式（sh518880）：第 0 位是名称，现价第 3 位、昨收第 2 位', () => {
    const q = parseSinaQuoteLine(
      'var hq_str_sh518880="黄金ETF华安,8.486,8.633,8.472,8.519,8.468,8.471,8.472,314669410,2673891380.000,36700,8.471,1529100,8.470,299000,8.469,885000,8.468,484700,8.467,354600,8.472,120800,8.473,511600,8.474,910900,8.475,87500,8.476,2026-10-08,14:07:14,00,";',
    );
    expect(q).toEqual({ price: 8.472, prev: 8.633 });
  });

  it('外汇格式（fx_susdcny）：跳过首字段时间，汇率在第 1 位', () => {
    const q = parseSinaQuoteLine(
      'var hq_str_fx_susdcny="14:20:02,6.7015000000,6.7017000000,6.7050000000,28.0000000000,6.7030000000,6.7039000000,6.7011000000,6.7015000000,在岸人民币,-0.0522,-0.0035,0.0028,新浪财经美元外汇,0.00";',
    );
    expect(q).not.toBeNull();
    expect(q!.price).toBeCloseTo(6.7015, 4);
  });

  it('垃圾/空输入返回 null', () => {
    expect(parseSinaQuoteLine('var hq_str_AU9999="";')).toBeNull();
    expect(parseSinaQuoteLine('no quote here')).toBeNull();
  });
});
