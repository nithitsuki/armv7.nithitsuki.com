// ARMv7 Partial Assembler — progressive decode as you type

export type InstrType = 'data-proc' | 'branch' | 'load-store' | 'ldm-stm' | 'mul' | 'unknown';

export type FieldColor =
  | 'cond' | 'type' | 'I' | 'opcode' | 'S' | 'Rn' | 'Rd' | 'op2'
  | 'op2-rot' | 'op2-imm' | 'op2-shift-amt' | 'op2-shift-type' | 'op2-rs' | 'op2-rm'
  | 'L' | 'offset' | 'fixed' | 'P' | 'U' | 'B' | 'W' | 'A' | 'reglist'
  | 'unknown';

export interface FieldMeta {
  name: string;
  shortName: string;
  highBit: number; // 31..0
  lowBit: number;
  color: FieldColor;
  value: number;
  known: boolean;
  display: string;
  description: string;
}

export interface FlagInfo {
  name: string;
  value: string;
  known: boolean;
  description: string;
}

export interface PartialResult {
  encoding: number;  // 32-bit value, unknowns are 0
  mask: number;      // bitmask: 1 = bit is known
  instrType: InstrType;
  fields: FieldMeta[];
  flags: FlagInfo[];
  hex: string;
  mnemonic?: string;
  error?: string;
  partial: boolean;
}

// ─── helpers ────────────────────────────────────────────────────────────────

const COND_NAMES: readonly string[] = [
  'EQ','NE','CS','CC','MI','PL','VS','VC','HI','LS','GE','LT','GT','LE','AL','NV',
];
const COND_MEANINGS: readonly string[] = [
  'Equal (Z=1)',
  'Not equal (Z=0)',
  'Carry set / unsigned higher or same (C=1)',
  'Carry clear / unsigned lower (C=0)',
  'Minus / negative (N=1)',
  'Plus / positive or zero (N=0)',
  'Overflow (V=1)',
  'No overflow (V=0)',
  'Unsigned higher (C=1, Z=0)',
  'Unsigned lower or same (C=0 or Z=1)',
  'Signed ≥ (N=V)',
  'Signed < (N≠V)',
  'Signed > (Z=0, N=V)',
  'Signed ≤ (Z=1 or N≠V)',
  'Always (unconditional)',
  'Never (ARMv1–v5 only)',
];

const COND_MAP: Record<string, number> = {
  EQ:0, NE:1, CS:2, HS:2, CC:3, LO:3,
  MI:4, PL:5, VS:6, VC:7, HI:8, LS:9,
  GE:10, LT:11, GT:12, LE:13, AL:14,
};

const DATA_OPS: Record<string, number> = {
  AND:0, EOR:1, SUB:2, RSB:3, ADD:4, ADC:5, SBC:6, RSC:7,
  TST:8, TEQ:9, CMP:10, CMN:11, ORR:12, MOV:13, BIC:14, MVN:15,
};
const DATA_OP_NAMES = ['AND','EOR','SUB','RSB','ADD','ADC','SBC','RSC',
  'TST','TEQ','CMP','CMN','ORR','MOV','BIC','MVN'];

const DATA_OP_DESC: Record<string, string> = {
  AND: 'Rd = Rn AND Op2',
  EOR: 'Rd = Rn EOR Op2',
  SUB: 'Rd = Rn − Op2',
  RSB: 'Rd = Op2 − Rn',
  ADD: 'Rd = Rn + Op2',
  ADC: 'Rd = Rn + Op2 + C',
  SBC: 'Rd = Rn − Op2 − 1 + C',
  RSC: 'Rd = Op2 − Rn − 1 + C',
  TST: 'Set flags for Rn AND Op2',
  TEQ: 'Set flags for Rn EOR Op2',
  CMP: 'Set flags for Rn − Op2',
  CMN: 'Set flags for Rn + Op2',
  ORR: 'Rd = Rn OR Op2',
  MOV: 'Rd = Op2',
  BIC: 'Rd = Rn AND NOT Op2',
  MVN: 'Rd = NOT Op2',
};

const SHIFT_NAMES = ['LSL','LSR','ASR','ROR'];
const SHIFT_DESC = [
  'Logical Shift Left',
  'Logical Shift Right',
  'Arithmetic Shift Right',
  'Rotate Right',
];

const TEST_OPS = new Set(['TST','TEQ','CMP','CMN']);
const MOVE_OPS = new Set(['MOV','MVN']);

function regName(n: number): string {
  if (n === 13) return 'SP';
  if (n === 14) return 'LR';
  if (n === 15) return 'PC';
  return `R${n}`;
}

function setBits(enc: number, mask: number, highBit: number, lowBit: number, value: number): [number, number] {
  const width = highBit - lowBit + 1;
  const bits = (value & ((1 << width) - 1)) >>> 0;
  const fieldMask = (((1 << width) - 1) << lowBit) >>> 0;
  enc = ((enc & ~fieldMask) | (bits << lowBit)) >>> 0;
  mask = (mask | fieldMask) >>> 0;
  return [enc, mask];
}

function tryParseRegister(s: string): number | null {
  s = s.trim().toUpperCase();
  if (s === 'SP') return 13;
  if (s === 'LR') return 14;
  if (s === 'PC') return 15;
  if (s === 'IP') return 12;
  if (s === 'FP') return 11;
  const m = s.match(/^R(\d+)$/);
  if (m) {
    const n = parseInt(m[1]);
    if (n >= 0 && n <= 15) return n;
  }
  return null;
}

function tryParseImmediate(s: string): number | null {
  s = s.trim();
  if (s.startsWith('#')) s = s.slice(1);
  const neg = s.startsWith('-');
  if (neg) s = s.slice(1);
  let val: number;
  if (s.startsWith('0x') || s.startsWith('0X')) {
    val = parseInt(s, 16);
  } else if (/^\d+$/.test(s)) {
    val = parseInt(s, 10);
  } else {
    return null;
  }
  return isNaN(val) ? null : (neg ? -val : val);
}

function tryEncodeImmediate(value: number): number | null {
  value = value >>> 0;
  for (let rot = 0; rot < 16; rot++) {
    const shift = rot * 2;
    const unrotated = shift === 0 ? value : ((value << shift) | (value >>> (32 - shift))) >>> 0;
    if ((unrotated & 0xFF) === unrotated) {
      return (rot << 8) | unrotated;
    }
  }
  return null;
}

// Splits "ADD", "ADDEQ", "ADDS", "ADDEQS", "ADDSNE" etc.
function parseMnemonicCondS(mnemonic: string): { op: string; cond: number; condKnown: boolean; sFlag: boolean; sFlagKnown: boolean } {
  let opBase = mnemonic.toUpperCase();
  let cond = 14; // AL
  let condKnown = false;
  let sFlag = false;
  let sFlagKnown = false;

  const condKeys = Object.keys(COND_MAP).sort((a, b) => b.length - a.length);
  for (const condName of condKeys) {
    if (opBase.endsWith(condName)) {
      const base = opBase.slice(0, -condName.length);
      const baseS = base.endsWith('S') ? base.slice(0, -1) : base;
      if (base in DATA_OPS || baseS in DATA_OPS || isKnownMnemonic(base) || isKnownMnemonic(baseS)) {
        cond = COND_MAP[condName];
        condKnown = true;
        opBase = base;
        break;
      }
    }
  }

  if (opBase.endsWith('S')) {
    const baseNoS = opBase.slice(0, -1);
    if (baseNoS in DATA_OPS || isKnownMnemonic(baseNoS)) {
      sFlag = true;
      sFlagKnown = true;
      opBase = baseNoS;
    }
  }

  // cond is always known (defaults to AL=14)
  if (!condKnown) { cond = 14; condKnown = true; }

  return { op: opBase, cond, condKnown, sFlag, sFlagKnown };
}

function isKnownMnemonic(op: string): boolean {
  const known = new Set(['B','BL','BX','BLX','LDR','STR','LDRB','STRB','LDRH','STRH',
    'PUSH','POP','MUL','MLA','NOP','LSL','LSR','ASR','ROR',
    'LDMIA','LDMIB','LDMDA','LDMDB','STMIA','STMIB','STMDA','STMDB',
    'LDM','STM','STMFD','LDMFD']);
  return known.has(op) || op in DATA_OPS;
}

// Split top-level comma-separated tokens (respecting brackets/braces)
function splitArgs(s: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let depth = 0;
  for (const ch of s) {
    if (ch === '[' || ch === '{') { depth++; cur += ch; }
    else if (ch === ']' || ch === '}') { depth--; cur += ch; }
    else if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; }
    else { cur += ch; }
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

// ─── field builders ──────────────────────────────────────────────────────────

function condField(cond: number): FieldMeta {
  return {
    name: 'Condition', shortName: 'cond',
    highBit: 31, lowBit: 28, color: 'cond',
    value: cond, known: true,
    display: cond.toString(2).padStart(4,'0') + ` (${COND_NAMES[cond]})`,
    description: COND_MEANINGS[cond] ?? '',
  };
}

function unknownField(name: string, shortName: string, high: number, low: number, color: FieldColor, desc: string): FieldMeta {
  return {
    name, shortName, highBit: high, lowBit: low, color,
    value: 0, known: false,
    display: '?'.repeat(high - low + 1),
    description: desc,
  };
}

function fixedField(name: string, shortName: string, high: number, low: number, value: number, desc: string): FieldMeta {
  return {
    name, shortName, highBit: high, lowBit: low, color: 'fixed',
    value, known: true,
    display: value.toString(2).padStart(high - low + 1, '0'),
    description: desc,
  };
}

function singleBitField(shortName: string, bit: number, color: FieldColor, value: number | null, knownDesc: (v:number)=>string, unknownDesc: string): FieldMeta {
  const known = value !== null;
  const v = value ?? 0;
  return {
    name: shortName, shortName,
    highBit: bit, lowBit: bit, color,
    value: v, known,
    display: known ? `${v}` : '?',
    description: known ? knownDesc(v) : unknownDesc,
  };
}

function regField(shortName: string, high: number, low: number, color: FieldColor, regNum: number | null, desc: string): FieldMeta {
  const known = regNum !== null;
  const v = regNum ?? 0;
  return {
    name: shortName, shortName,
    highBit: high, lowBit: low, color,
    value: v, known,
    display: known ? `${v.toString(2).padStart(4,'0')} (${regName(v)})` : '????',
    description: known ? `${desc}: ${regName(v)}` : `${desc} (unknown)`,
  };
}

// ─── data processing fields ──────────────────────────────────────────────────

function buildDataProcFields(params: {
  cond: number;
  opcodeNum: number | null;
  sFlag: boolean | null;
  rnNum: number | null;
  rdNum: number | null;
  op2enc: number | null;  // 12-bit encoded operand2
  isImm: boolean | null;
}): FieldMeta[] {
  const { cond, opcodeNum, sFlag, rnNum, rdNum, op2enc, isImm } = params;
  const fields: FieldMeta[] = [];

  fields.push(condField(cond));
  fields.push(fixedField('Type', 'type', 27, 26, 0b00, 'Data processing instruction class'));

  fields.push(singleBitField('I', 25, 'I', isImm === null ? null : (isImm ? 1 : 0),
    v => v ? 'Operand2 is an immediate value' : 'Operand2 is a register (+ optional shift)',
    'Immediate flag (unknown)',
  ));

  if (opcodeNum !== null) {
    fields.push({
      name: 'Opcode', shortName: 'op',
      highBit: 24, lowBit: 21, color: 'opcode',
      value: opcodeNum, known: true,
      display: `${opcodeNum.toString(2).padStart(4,'0')} (${DATA_OP_NAMES[opcodeNum]})`,
      description: DATA_OP_DESC[DATA_OP_NAMES[opcodeNum]] ?? '',
    });
  } else {
    fields.push(unknownField('Opcode', 'op', 24, 21, 'opcode', 'Operation code'));
  }

  // S bit — not meaningful for test ops
  const opName = opcodeNum !== null ? DATA_OP_NAMES[opcodeNum] : null;
  if (opName && TEST_OPS.has(opName)) {
    fields.push(fixedField('S (forced)', 'S', 20, 20, 1, 'Always 1 for test/compare ops'));
  } else {
    fields.push(singleBitField('S', 20, 'S', sFlag === null ? null : (sFlag ? 1 : 0),
      v => v ? 'Sets N, Z, C, V flags' : 'Does not update flags',
      'Set flags bit (unknown)',
    ));
  }

  // For test ops (TST, TEQ, CMP, CMN): no Rd
  const isTestOp = opName ? TEST_OPS.has(opName) : false;
  const isMoveOp = opName ? MOVE_OPS.has(opName) : false;

  if (isTestOp) {
    fields.push(regField('Rn', 19, 16, 'Rn', rnNum, 'Source/compare register'));
    fields.push(fixedField('Rd (SBZ)', 'Rd', 15, 12, 0, 'Should Be Zero for test ops'));
  } else if (isMoveOp) {
    fields.push(fixedField('Rn (SBZ)', 'Rn', 19, 16, 0, 'Should Be Zero for MOV/MVN'));
    fields.push(regField('Rd', 15, 12, 'Rd', rdNum, 'Destination register'));
  } else {
    fields.push(regField('Rn', 19, 16, 'Rn', rnNum, 'First source register'));
    fields.push(regField('Rd', 15, 12, 'Rd', rdNum, 'Destination register'));
  }

  // Operand2
  if (op2enc !== null && isImm !== null) {
    if (isImm) {
      const rot = (op2enc >>> 8) & 0xF;
      const imm8 = op2enc & 0xFF;
      const actualVal = rot === 0 ? imm8 : ((imm8 >>> (rot*2)) | (imm8 << (32 - rot*2))) >>> 0;
      fields.push({
        name: 'Rotate', shortName: 'rot',
        highBit: 11, lowBit: 8, color: 'op2-rot',
        value: rot, known: true,
        display: `${rot.toString(2).padStart(4,'0')} (×2=${rot*2})`,
        description: `Right-rotate imm8 by ${rot*2} bits`,
      });
      fields.push({
        name: 'Imm8', shortName: 'imm',
        highBit: 7, lowBit: 0, color: 'op2-imm',
        value: imm8, known: true,
        display: `${imm8.toString(2).padStart(8,'0')} (0x${imm8.toString(16).toUpperCase()} = ${actualVal})`,
        description: `8-bit immediate, rotated value = ${actualVal}`,
      });
    } else {
      const byReg = (op2enc >>> 4) & 1;
      const shiftType = (op2enc >>> 5) & 3;
      const rm = op2enc & 0xF;
      if (byReg) {
        const rs = (op2enc >>> 8) & 0xF;
        fields.push({
          name: 'Rs', shortName: 'Rs',
          highBit: 11, lowBit: 8, color: 'op2-rs',
          value: rs, known: true,
          display: `${rs.toString(2).padStart(4,'0')} (${regName(rs)})`,
          description: `Shift amount register: ${regName(rs)}`,
        });
        fields.push(fixedField('Bit 4', 'b4', 7, 7, 0, 'Bit 7 (MUL disambiguation)'));
        fields.push(fixedField('Shift by Reg', '1', 4, 4, 1, 'Shift amount from register'));
      } else {
        const shiftAmt = (op2enc >>> 7) & 0x1F;
        fields.push({
          name: 'Shift Amt', shortName: 'shamt',
          highBit: 11, lowBit: 7, color: 'op2-shift-amt',
          value: shiftAmt, known: true,
          display: `${shiftAmt.toString(2).padStart(5,'0')} (${shiftAmt})`,
          description: `Shift amount: ${shiftAmt} bits`,
        });
        fields.push(fixedField('Bit 4', 'b4', 4, 4, 0, 'Shift by immediate (not register)'));
      }
      fields.push({
        name: 'Shift Type', shortName: 'stype',
        highBit: 6, lowBit: 5, color: 'op2-shift-type',
        value: shiftType, known: true,
        display: `${shiftType.toString(2).padStart(2,'0')} (${SHIFT_NAMES[shiftType]})`,
        description: SHIFT_DESC[shiftType],
      });
      fields.push({
        name: 'Rm', shortName: 'Rm',
        highBit: 3, lowBit: 0, color: 'op2-rm',
        value: rm, known: true,
        display: `${rm.toString(2).padStart(4,'0')} (${regName(rm)})`,
        description: `Operand register: ${regName(rm)}`,
      });
    }
  } else {
    fields.push(unknownField('Operand 2', 'op2', 11, 0, 'op2', 'Shifted register or immediate'));
  }

  return fields;
}

// ─── branch fields ───────────────────────────────────────────────────────────

function buildBranchFields(cond: number, link: boolean, offsetEnc: number | null): FieldMeta[] {
  const fields: FieldMeta[] = [];
  fields.push(condField(cond));
  fields.push(fixedField('Type', 'type', 27, 25, 0b101, 'Branch instruction class'));
  fields.push({
    name: 'L (Link)', shortName: 'L',
    highBit: 24, lowBit: 24, color: 'L',
    value: link ? 1 : 0, known: true,
    display: link ? '1' : '0',
    description: link ? 'Branch with link (saves PC to LR)' : 'Branch (no link)',
  });
  if (offsetEnc !== null) {
    fields.push({
      name: 'Offset', shortName: 'offset',
      highBit: 23, lowBit: 0, color: 'offset',
      value: offsetEnc, known: true,
      display: `0x${offsetEnc.toString(16).toUpperCase().padStart(6,'0')}`,
      description: `PC-relative byte offset = ${(((offsetEnc << 8) >> 8) * 4) + 8}`,
    });
  } else {
    fields.push(unknownField('Offset', 'offset', 23, 0, 'offset', '24-bit signed PC-relative word offset'));
  }
  return fields;
}

// ─── main partial assemble ───────────────────────────────────────────────────

export function partialAssemble(text: string): PartialResult {
  // Clean up
  const raw = text.trim().replace(/[;@].*$/, '').replace(/^[A-Za-z_][A-Za-z0-9_]*:\s*/, '').trim();

  if (!raw) {
    return emptyResult();
  }

  // Extract mnemonic token (first word)
  const firstSpace = raw.search(/[\s,]/);
  const mnemToken = firstSpace >= 0 ? raw.slice(0, firstSpace) : raw;
  const argsRaw = firstSpace >= 0 ? raw.slice(firstSpace).trim() : '';

  const { op, cond, sFlag, sFlagKnown } = parseMnemonicCondS(mnemToken);

  // NOP
  if (op === 'NOP') {
    const encoding = (cond << 28) | 0x0320F000;
    return makeResult(encoding, 0xFFFFFFFF, 'data-proc', buildNopFields(cond), [], false);
  }

  // Branch family
  if (op === 'B' || op === 'BL' || op === 'BX' || op === 'BLX') {
    return partialBranch(op, cond, argsRaw);
  }

  // Load/store
  if (['LDR','STR','LDRB','STRB','LDRH','STRH'].includes(op)) {
    return partialLoadStore(op, cond, argsRaw);
  }

  // Multiply
  if (op === 'MUL' || op === 'MLA') {
    return partialMul(op, cond, sFlag, argsRaw);
  }

  // Push/Pop (aliases for LDM/STM)
  if (op === 'PUSH' || op === 'POP') {
    return partialPushPop(op, cond, argsRaw);
  }

  // LDM/STM
  if (op.startsWith('LDM') || op.startsWith('STM')) {
    return partialLdmStm(op, cond, argsRaw);
  }

  // Shift aliases
  if (['LSL','LSR','ASR','ROR'].includes(op)) {
    return partialShiftAlias(op, cond, sFlag, argsRaw);
  }

  // Data processing
  if (op in DATA_OPS) {
    return partialDataProc(op, cond, sFlag, sFlagKnown, argsRaw);
  }

  // Unknown mnemonic — partial cond
  return unknownMnemResult(mnemToken, cond);
}

// ─── data processing ─────────────────────────────────────────────────────────

function partialDataProc(
  op: string, cond: number, sFlag: boolean, sFlagKnown: boolean, argsRaw: string
): PartialResult {
  const opcodeNum = DATA_OPS[op];
  const isTestOp = TEST_OPS.has(op);
  const isMoveOp = MOVE_OPS.has(op);
  const forcedS = isTestOp;

  let enc = 0, mask = 0;
  [enc, mask] = setBits(enc, mask, 31, 28, cond);
  [enc, mask] = setBits(enc, mask, 27, 26, 0b00);
  [enc, mask] = setBits(enc, mask, 24, 21, opcodeNum);
  // S bit: default to 0 when not explicitly set (no 'S' suffix = no flag update)
  [enc, mask] = setBits(enc, mask, 20, 20, forcedS ? 1 : (sFlag ? 1 : 0));
  // Mark S as known even without explicit suffix — default is 0
  if (!sFlagKnown && !forcedS) { sFlagKnown = true; sFlag = false; }

  const args = splitArgs(argsRaw);
  let rdNum: number | null = null;
  let rnNum: number | null = null;
  let op2enc: number | null = null;
  let isImm: boolean | null = null;

  // For test ops: args = [Rn, Op2]
  // For move ops: args = [Rd, Op2]
  // For normal:  args = [Rd, Rn, Op2]
  if (isTestOp) {
    // Rd is SBZ (Should Be Zero) for test ops — set it in encoding
    [enc, mask] = setBits(enc, mask, 15, 12, 0);
    if (args.length >= 1) {
      rnNum = tryParseRegister(args[0]);
      if (rnNum !== null) [enc, mask] = setBits(enc, mask, 19, 16, rnNum);
    }
    if (args.length >= 2) {
      ({ op2enc, isImm, enc, mask } = parseOp2(args.slice(1).join(','), enc, mask));
    }
  } else if (isMoveOp) {
    // Rn is SBZ (Should Be Zero) for MOV/MVN — set it in encoding
    [enc, mask] = setBits(enc, mask, 19, 16, 0);
    if (args.length >= 1) {
      rdNum = tryParseRegister(args[0]);
      if (rdNum !== null) [enc, mask] = setBits(enc, mask, 15, 12, rdNum);
    }
    if (args.length >= 2) {
      ({ op2enc, isImm, enc, mask } = parseOp2(args.slice(1).join(','), enc, mask));
    }
  } else {
    if (args.length >= 1) {
      rdNum = tryParseRegister(args[0]);
      if (rdNum !== null) [enc, mask] = setBits(enc, mask, 15, 12, rdNum);
    }
    if (args.length >= 2) {
      rnNum = tryParseRegister(args[1]);
      if (rnNum !== null) [enc, mask] = setBits(enc, mask, 19, 16, rnNum);
    }
    if (args.length >= 3) {
      ({ op2enc, isImm, enc, mask } = parseOp2(args.slice(2).join(','), enc, mask));
    }
  }

  const fields = buildDataProcFields({ cond, opcodeNum, sFlag: forcedS ? true : sFlag, rnNum, rdNum, op2enc, isImm });

  // Flags panel
  const flags: FlagInfo[] = [
    {
      name: 'cond', value: `${COND_NAMES[cond]} (${cond.toString(2).padStart(4,'0')})`,
      known: true, description: COND_MEANINGS[cond] ?? '',
    },
    {
      name: 'op', value: `${DATA_OP_NAMES[opcodeNum]} — ${DATA_OP_DESC[DATA_OP_NAMES[opcodeNum]] ?? ''}`,
      known: true, description: '',
    },
    {
      name: 'I', value: isImm === null ? '?' : (isImm ? '1 (immediate)' : '0 (register)'),
      known: isImm !== null, description: 'Operand2 mode: 1=immediate, 0=shifted register',
    },
    {
      name: 'S', value: forcedS ? '1 (forced — test op)' : (sFlagKnown ? (sFlag ? '1 (set flags)' : '0 (preserve flags)') : '?'),
      known: sFlagKnown || forcedS, description: 'Update N/Z/C/V condition flags',
    },
  ];
  if (!isTestOp && !isMoveOp && rnNum !== null) flags.push({ name: 'Rn', value: regName(rnNum), known: true, description: 'First source register' });
  if (!isTestOp && rdNum !== null) flags.push({ name: 'Rd', value: regName(rdNum), known: true, description: 'Destination register' });
  if (isTestOp && rnNum !== null) flags.push({ name: 'Rn', value: regName(rnNum), known: true, description: 'Compare/test register' });
  if (isImm !== null && op2enc !== null) {
    if (isImm) {
      const rot = (op2enc >>> 8) & 0xF;
      const imm8 = op2enc & 0xFF;
      const actual = rot === 0 ? imm8 : ((imm8 >>> (rot*2)) | (imm8 << (32-rot*2))) >>> 0;
      flags.push({ name: 'imm', value: `${actual} (0x${actual.toString(16).toUpperCase()}), rot=${rot}`, known: true, description: 'Immediate value (rotated)' });
    } else {
      const rm = op2enc & 0xF;
      const shiftType = (op2enc >>> 5) & 3;
      const byReg = (op2enc >>> 4) & 1;
      if (byReg) {
        const rs = (op2enc >>> 8) & 0xF;
        flags.push({ name: 'shift', value: `${regName(rm)}, ${SHIFT_NAMES[shiftType]} ${regName(rs)}`, known: true, description: 'Register-controlled shift' });
      } else {
        const amt = (op2enc >>> 7) & 0x1F;
        flags.push({ name: 'shift', value: `${regName(rm)}, ${SHIFT_NAMES[shiftType]} #${amt}`, known: true, description: 'Immediate shift' });
      }
    }
  }

  const partial = (mask >>> 0) !== 0xFFFFFFFF;
  return makeResult(enc, mask, 'data-proc', fields, flags, partial);
}

// ─── operand2 parser ─────────────────────────────────────────────────────────

function parseOp2(raw: string, enc: number, mask: number): { op2enc: number; isImm: boolean; enc: number; mask: number } {
  raw = raw.trim();
  if (raw.startsWith('#')) {
    const val = tryParseImmediate(raw);
    if (val !== null) {
      const encoded = tryEncodeImmediate(val >>> 0);
      if (encoded !== null) {
        [enc, mask] = setBits(enc, mask, 25, 25, 1);  // I=1
        [enc, mask] = setBits(enc, mask, 11, 0, encoded);
        return { op2enc: encoded, isImm: true, enc, mask };
      }
    }
    [enc, mask] = setBits(enc, mask, 25, 25, 1);
    return { op2enc: 0, isImm: true, enc, mask };
  }

  const commaIdx = raw.indexOf(',');
  const rmStr = commaIdx >= 0 ? raw.slice(0, commaIdx) : raw;
  const rm = tryParseRegister(rmStr);
  if (rm === null) return { op2enc: 0, isImm: false, enc, mask };

  [enc, mask] = setBits(enc, mask, 25, 25, 0);  // I=0
  [enc, mask] = setBits(enc, mask, 3, 0, rm);

  let op2enc = rm;
  if (commaIdx >= 0) {
    const shiftExpr = raw.slice(commaIdx + 1).trim();
    const m = shiftExpr.match(/^(LSL|LSR|ASR|ROR|RRX)\s*(.*)$/i);
    if (m) {
      const types: Record<string, number> = { LSL:0, LSR:1, ASR:2, ROR:3, RRX:3 };
      const shiftType = types[m[1].toUpperCase()];
      const shiftVal = m[2].trim();
      if (!shiftVal || m[1].toUpperCase() === 'RRX') {
        op2enc = (0 << 7) | (shiftType << 5) | rm;
        [enc, mask] = setBits(enc, mask, 11, 4, op2enc >> 4);
      } else if (shiftVal.startsWith('#') || /^\d/.test(shiftVal)) {
        const amt = (tryParseImmediate(shiftVal) ?? 0) & 0x1F;
        op2enc = (amt << 7) | (shiftType << 5) | rm;
        [enc, mask] = setBits(enc, mask, 11, 0, op2enc);
      } else {
        const rs = tryParseRegister(shiftVal);
        if (rs !== null) {
          op2enc = (rs << 8) | (shiftType << 5) | (1 << 4) | rm;
          [enc, mask] = setBits(enc, mask, 11, 0, op2enc);
        }
      }
    } else {
      op2enc = rm;
    }
  }

  return { op2enc, isImm: false, enc, mask };
}

// ─── branch ──────────────────────────────────────────────────────────────────

function partialBranch(op: string, cond: number, argsRaw: string): PartialResult {
  if (op === 'BX' || op === 'BLX') {
    const rm = tryParseRegister(argsRaw);
    if (rm !== null) {
      const enc = op === 'BX'
        ? ((cond << 28) | 0x012FFF10 | rm) >>> 0
        : ((cond << 28) | 0x012FFF30 | rm) >>> 0;
      const fields: FieldMeta[] = [
        condField(cond),
        fixedField('type', 'type', 27, 20, 0b00010010, 'BX encoding pattern'),
        fixedField('SBO', 'sbo', 19, 8, 0xFFF, 'Should Be One'),
        singleBitField('L', 5, 'L', op === 'BLX' ? 1 : 0, v => v ? 'Branch with link' : 'Branch exchange', ''),
        fixedField('fixed', 'b4321', 7, 4, 0b0001, 'BX/BLX signature'),
        regField('Rm', 3, 0, 'op2-rm', rm, 'Register with branch target'),
      ];
      const flags: FlagInfo[] = [
        { name: 'cond', value: COND_NAMES[cond], known: true, description: COND_MEANINGS[cond] },
        { name: 'L', value: op === 'BLX' ? '1 (link)' : '0 (no link)', known: true, description: '' },
        { name: 'Rm', value: regName(rm), known: true, description: 'Target address register' },
      ];
      return makeResult(enc, 0xFFFFFFFF, 'branch', fields, flags, false);
    }
  }

  const link = op === 'BL';
  let enc = 0, mask = 0;
  [enc, mask] = setBits(enc, mask, 31, 28, cond);
  [enc, mask] = setBits(enc, mask, 27, 25, 0b101);
  [enc, mask] = setBits(enc, mask, 24, 24, link ? 1 : 0);

  let offsetEnc: number | null = null;
  const args = argsRaw.trim();
  if (args) {
    const raw = args.startsWith('#') ? args.slice(1) : args;
    const byteOff = tryParseImmediate(raw);
    if (byteOff !== null) {
      const word = Math.floor((byteOff - 8) / 4);
      offsetEnc = word & 0xFFFFFF;
      [enc, mask] = setBits(enc, mask, 23, 0, offsetEnc);
    }
  }

  const fields = buildBranchFields(cond, link, offsetEnc);
  const flags: FlagInfo[] = [
    { name: 'cond', value: COND_NAMES[cond], known: true, description: COND_MEANINGS[cond] },
    { name: 'L', value: link ? '1 (saves ret addr to LR)' : '0 (no return link)', known: true, description: '' },
    { name: 'offset', value: offsetEnc !== null ? `word offset: ${(offsetEnc << 8) >> 8}` : '?', known: offsetEnc !== null, description: 'Signed 24-bit offset' },
  ];

  const partial = (mask >>> 0) !== 0xFFFFFFFF;
  return makeResult(enc, mask, 'branch', fields, flags, partial);
}

// ─── load/store ───────────────────────────────────────────────────────────────

function partialLoadStore(op: string, cond: number, argsRaw: string): PartialResult {
  const isLoad = op.startsWith('LDR');
  const isByte = op.endsWith('B');
  const isHalf = op.endsWith('H');

  let enc = 0, mask = 0;
  [enc, mask] = setBits(enc, mask, 31, 28, cond);
  if (!isHalf) {
    [enc, mask] = setBits(enc, mask, 27, 26, 0b01);
    [enc, mask] = setBits(enc, mask, 22, 22, isByte ? 1 : 0);
  }
  [enc, mask] = setBits(enc, mask, 20, 20, isLoad ? 1 : 0);

  const args = splitArgs(argsRaw);
  let rdNum: number | null = null;
  let rnNum: number | null = null;

  // Addressing mode parsed values
  let pBit: number | null = null;   // P: 1=pre-index, 0=post-index
  let uBit: number | null = null;   // U: 1=add, 0=subtract
  let wBit: number | null = null;   // W: 1=writeback
  let iBit: number | null = null;   // I: 0=immediate offset, 1=register offset (note: inverted vs data-proc)
  let offsetVal: number | null = null;
  let offsetRm: number | null = null;
  let offsetShiftType: number | null = null;
  let offsetShiftAmt: number | null = null;

  // Parse Rd
  if (args.length >= 1) {
    rdNum = tryParseRegister(args[0]);
    if (rdNum !== null) [enc, mask] = setBits(enc, mask, 15, 12, rdNum);
  }

  // Parse addressing mode from remaining args
  if (args.length >= 2) {
    const addrStr = args.slice(1).join(',').trim();

    // Pre-indexed: [Rn] or [Rn, #imm] or [Rn, #imm]! or [Rn, Rm] or [Rn, Rm, shift]!
    const preMatch = addrStr.match(/^\[([^,\]]+)(?:,\s*([^\]]*))?\](!)?$/);
    // Post-indexed: [Rn], #imm or [Rn], Rm
    const postMatch = !preMatch ? addrStr.match(/^\[([^\]]+)\]\s*,\s*(.+)$/) : null;

    if (preMatch) {
      // Pre-indexed addressing
      pBit = 1;
      const hasWriteback = !!preMatch[3]; // the !
      wBit = hasWriteback ? 1 : 0;

      rnNum = tryParseRegister(preMatch[1]);
      if (rnNum !== null) [enc, mask] = setBits(enc, mask, 19, 16, rnNum);

      const offsetStr = preMatch[2]?.trim();
      if (offsetStr) {
        parseLoadStoreOffset(offsetStr);
      } else {
        // [Rn] — zero immediate offset
        iBit = 0;
        uBit = 1;
        offsetVal = 0;
      }
    } else if (postMatch) {
      // Post-indexed addressing
      pBit = 0;
      wBit = 0; // W=0 for post-index (T bit territory, but standard is 0)

      rnNum = tryParseRegister(postMatch[1]);
      if (rnNum !== null) [enc, mask] = setBits(enc, mask, 19, 16, rnNum);

      const offsetStr = postMatch[2]?.trim();
      if (offsetStr) {
        parseLoadStoreOffset(offsetStr);
      }
    } else {
      // Try to at least get Rn from partial typing like [R1
      const rnMatch = addrStr.match(/\[?(\w+)/);
      if (rnMatch) {
        rnNum = tryParseRegister(rnMatch[1]);
        if (rnNum !== null) [enc, mask] = setBits(enc, mask, 19, 16, rnNum);
      }
    }
  }

  function parseLoadStoreOffset(s: string) {
    s = s.trim();
    // Check for negative prefix
    let sign = 1;
    if (s.startsWith('-')) { sign = -1; s = s.slice(1).trim(); }
    else if (s.startsWith('+')) { s = s.slice(1).trim(); }

    // Immediate: #value
    if (s.startsWith('#') || /^-?(?:0x[\da-f]+|\d+)$/i.test(s)) {
      iBit = 0; // I=0 for immediate offset in LDR/STR
      const imm = tryParseImmediate(s);
      if (imm !== null) {
        const absImm = Math.abs(imm) * (sign < 0 ? -1 : 1);
        uBit = absImm >= 0 ? 1 : 0;
        offsetVal = Math.abs(absImm) & 0xFFF;
      }
    } else {
      // Register offset: Rm or Rm, shift
      iBit = 1; // I=1 for register offset in LDR/STR
      uBit = sign >= 0 ? 1 : 0;
      // Could be "Rm" or "Rm, LSL #n"
      const parts = s.split(',').map(p => p.trim());
      offsetRm = tryParseRegister(parts[0]);
      if (parts.length >= 2) {
        const shiftMatch = parts[1].match(/^(LSL|LSR|ASR|ROR)\s+#?(\d+)$/i);
        if (shiftMatch) {
          const stMap: Record<string,number> = {LSL:0,LSR:1,ASR:2,ROR:3};
          offsetShiftType = stMap[shiftMatch[1].toUpperCase()] ?? 0;
          offsetShiftAmt = parseInt(shiftMatch[2]) & 0x1F;
        }
      }
    }
  }

  // Set encoding bits for parsed addressing
  if (iBit !== null) [enc, mask] = setBits(enc, mask, 25, 25, iBit);
  if (pBit !== null) [enc, mask] = setBits(enc, mask, 24, 24, pBit);
  if (uBit !== null) [enc, mask] = setBits(enc, mask, 23, 23, uBit);
  if (wBit !== null) [enc, mask] = setBits(enc, mask, 21, 21, wBit);

  if (iBit === 0 && offsetVal !== null) {
    // Immediate offset: 12-bit unsigned in [11:0]
    [enc, mask] = setBits(enc, mask, 11, 0, offsetVal & 0xFFF);
  } else if (iBit === 1 && offsetRm !== null) {
    // Register offset
    [enc, mask] = setBits(enc, mask, 3, 0, offsetRm);
    if (offsetShiftType !== null && offsetShiftAmt !== null) {
      [enc, mask] = setBits(enc, mask, 11, 7, offsetShiftAmt);
      [enc, mask] = setBits(enc, mask, 6, 5, offsetShiftType);
      [enc, mask] = setBits(enc, mask, 4, 4, 0); // shift by immediate (not register)
    } else {
      // No shift — LSL #0
      [enc, mask] = setBits(enc, mask, 11, 7, 0);
      [enc, mask] = setBits(enc, mask, 6, 5, 0);
      [enc, mask] = setBits(enc, mask, 4, 4, 0);
    }
  }

  // Build offset field
  let offsetField: FieldMeta;
  const offsetKnown = (iBit === 0 && offsetVal !== null) || (iBit === 1 && offsetRm !== null);
  if (offsetKnown) {
    if (iBit === 0) {
      const v = offsetVal ?? 0;
      offsetField = {
        name: 'Offset', shortName: 'off', highBit: 11, lowBit: 0, color: 'offset',
        value: v, known: true,
        display: `${v.toString(2).padStart(12, '0')} (#${uBit ? '+' : '-'}${v})`,
        description: `Immediate offset: ${uBit ? '+' : '-'}${v}`,
      };
    } else {
      const rmV = offsetRm ?? 0;
      offsetField = {
        name: 'Offset (Rm)', shortName: 'off', highBit: 11, lowBit: 0, color: 'offset',
        value: (enc >>> 0) & 0xFFF, known: true,
        display: `${regName(rmV)}${offsetShiftType !== null ? ', ' + SHIFT_NAMES[offsetShiftType] + ' #' + offsetShiftAmt : ''}`,
        description: `Register offset: ${uBit ? '+' : '-'}${regName(rmV)}${offsetShiftType !== null ? ', ' + SHIFT_NAMES[offsetShiftType] + ' #' + offsetShiftAmt : ''}`,
      };
    }
  } else {
    offsetField = unknownField('Offset/Rm', 'off', 11, 0, 'offset', 'Address offset');
  }

  const fields: FieldMeta[] = [
    condField(cond),
    fixedField('Type', 'type', 27, 26, 0b01, 'Load/Store instruction class'),
    singleBitField('I', 25, 'I', iBit, v => v ? 'Register offset' : 'Immediate offset', 'Offset type (unknown)'),
    singleBitField('P', 24, 'P', pBit, v => v ? 'Pre-index' : 'Post-index', 'Pre/post-index (unknown)'),
    singleBitField('U', 23, 'U', uBit, v => v ? 'Add offset (up)' : 'Subtract offset (down)', 'Up/Down (unknown)'),
    { name: 'B', shortName: 'B', highBit: 22, lowBit: 22, color: 'B' as FieldColor, value: isByte ? 1 : 0, known: true,
      display: isByte ? '1' : '0', description: isByte ? 'Byte transfer' : 'Word transfer' },
    singleBitField('W', 21, 'W', wBit, v => v ? 'Write-back base (!)' : 'No write-back', 'Write-back (unknown)'),
    { name: 'L', shortName: 'L', highBit: 20, lowBit: 20, color: 'L' as FieldColor, value: isLoad ? 1 : 0, known: true,
      display: isLoad ? '1' : '0', description: isLoad ? 'Load (memory → register)' : 'Store (register → memory)' },
    regField('Rn', 19, 16, 'Rn', rnNum, 'Base address register'),
    regField('Rd', 15, 12, 'Rd', rdNum, isLoad ? 'Destination register' : 'Source register'),
    offsetField,
  ];

  const flags: FlagInfo[] = [
    { name: 'cond', value: COND_NAMES[cond], known: true, description: COND_MEANINGS[cond] },
    { name: 'op', value: `${op} — ${isLoad ? 'Load' : 'Store'} (${isByte ? 'byte' : isHalf ? 'halfword' : 'word'})`, known: true, description: '' },
    { name: 'L', value: isLoad ? '1 (load)' : '0 (store)', known: true, description: '' },
    { name: 'B', value: isByte ? '1 (byte)' : '0 (word)', known: true, description: '' },
    { name: 'P', value: pBit !== null ? (pBit ? '1 (pre-index)' : '0 (post-index)') : '?', known: pBit !== null, description: '' },
    { name: 'U', value: uBit !== null ? (uBit ? '1 (add offset)' : '0 (subtract)') : '?', known: uBit !== null, description: '' },
    { name: 'W', value: wBit !== null ? (wBit ? '1 (write-back)' : '0 (no write-back)') : '?', known: wBit !== null, description: '' },
    { name: 'I', value: iBit !== null ? (iBit ? '1 (register)' : '0 (immediate)') : '?', known: iBit !== null, description: '' },
    { name: 'Rd', value: rdNum !== null ? regName(rdNum) : '?', known: rdNum !== null, description: '' },
    { name: 'Rn', value: rnNum !== null ? regName(rnNum) : '?', known: rnNum !== null, description: 'Base address' },
  ];

  const partial = (mask >>> 0) !== 0xFFFFFFFF;
  return makeResult(enc, mask, 'load-store', fields, flags, partial);
}

// ─── multiply ────────────────────────────────────────────────────────────────

function partialMul(op: string, cond: number, sFlag: boolean, argsRaw: string): PartialResult {
  const isAcc = op === 'MLA';
  let enc = 0, mask = 0;
  [enc, mask] = setBits(enc, mask, 31, 28, cond);
  [enc, mask] = setBits(enc, mask, 27, 22, 0b000000);
  [enc, mask] = setBits(enc, mask, 21, 21, isAcc ? 1 : 0);
  [enc, mask] = setBits(enc, mask, 7, 4, 0b1001);

  const args = splitArgs(argsRaw);
  let rdNum: number | null = null, rmNum: number | null = null;
  let rsNum: number | null = null, rnNum: number | null = null;

  if (args.length >= 1 && (rdNum = tryParseRegister(args[0])) !== null) [enc, mask] = setBits(enc, mask, 19, 16, rdNum);
  if (args.length >= 2 && (rmNum = tryParseRegister(args[1])) !== null) [enc, mask] = setBits(enc, mask, 3, 0, rmNum);
  if (args.length >= 3 && (rsNum = tryParseRegister(args[2])) !== null) [enc, mask] = setBits(enc, mask, 11, 8, rsNum);
  if (isAcc && args.length >= 4 && (rnNum = tryParseRegister(args[3])) !== null) [enc, mask] = setBits(enc, mask, 15, 12, rnNum);

  const fields: FieldMeta[] = [
    condField(cond),
    fixedField('type', 'type', 27, 22, 0, 'Multiply class (000000)'),
    singleBitField('A', 21, 'A', isAcc ? 1 : 0, v => v ? 'Multiply-Accumulate (MLA)' : 'Multiply (MUL)', ''),
    singleBitField('S', 20, 'S', sFlag ? 1 : 0, v => v ? 'Sets flags' : 'No flag update', ''),
    regField('Rd', 19, 16, 'Rd', rdNum, 'Destination register'),
    regField('Rn', 15, 12, 'Rn', isAcc ? rnNum : null, isAcc ? 'Accumulate register' : '(unused)'),
    regField('Rs', 11, 8, 'op2-rs', rsNum, 'Multiplier register'),
    fixedField('Sig', 'sig', 7, 4, 0b1001, 'Multiply signature (1001)'),
    regField('Rm', 3, 0, 'op2-rm', rmNum, 'Multiplicand register'),
  ];

  const flags: FlagInfo[] = [
    { name: 'cond', value: COND_NAMES[cond], known: true, description: COND_MEANINGS[cond] },
    { name: 'op', value: isAcc ? 'MLA: Rd = (Rm × Rs) + Rn' : 'MUL: Rd = Rm × Rs', known: true, description: '' },
    { name: 'A', value: isAcc ? '1 (accumulate)' : '0 (no accumulate)', known: true, description: '' },
  ];

  const partial = (mask >>> 0) !== 0xFFFFFFFF;
  return makeResult(enc, mask, 'mul', fields, flags, partial);
}

// ─── push/pop ────────────────────────────────────────────────────────────────

function partialPushPop(op: string, cond: number, argsRaw: string): PartialResult {
  const isPush = op === 'PUSH';
  let enc = 0, mask = 0;
  [enc, mask] = setBits(enc, mask, 31, 28, cond);
  [enc, mask] = setBits(enc, mask, 27, 25, 0b100);
  [enc, mask] = setBits(enc, mask, 24, 24, isPush ? 1 : 0); // P
  [enc, mask] = setBits(enc, mask, 23, 23, isPush ? 0 : 1); // U
  [enc, mask] = setBits(enc, mask, 21, 21, 1); // W
  [enc, mask] = setBits(enc, mask, 20, 20, isPush ? 0 : 1); // L
  [enc, mask] = setBits(enc, mask, 19, 16, 13); // SP

  const braceMatch = argsRaw.match(/\{([^}]*)\}/);
  let regList = 0;
  let regListKnown = false;
  if (braceMatch) {
    regListKnown = true;
    const regs = braceMatch[1].split(',').map(s => s.trim()).filter(Boolean);
    for (const r of regs) {
      const n = tryParseRegister(r);
      if (n !== null) regList |= (1 << n);
    }
    [enc, mask] = setBits(enc, mask, 15, 0, regList);
  }

  const fields: FieldMeta[] = [
    condField(cond),
    fixedField('Type', 'type', 27, 25, 0b100, 'Block data transfer'),
    fixedField('P', 'P', 24, 24, isPush ? 1 : 0, isPush ? 'Pre-decrement (DB)' : 'Post-increment (IA)'),
    fixedField('U', 'U', 23, 23, isPush ? 0 : 1, isPush ? 'Decrement (down)' : 'Increment (up)'),
    fixedField('W', 'W', 21, 21, 1, 'Write-back SP'),
    fixedField('L', 'L', 20, 20, isPush ? 0 : 1, isPush ? 'Store (PUSH)' : 'Load (POP)'),
    fixedField('Rn=SP', 'Rn', 19, 16, 13, 'Stack pointer (R13/SP)'),
    regListKnown
      ? { name: 'RegList', shortName: 'regs', highBit: 15, lowBit: 0, color: 'reglist', value: regList, known: true,
          display: `0x${regList.toString(16).toUpperCase().padStart(4,'0')}`, description: 'Bitmask of registers' }
      : unknownField('RegList', 'regs', 15, 0, 'reglist', 'Register list bitmask'),
  ];

  const flags: FlagInfo[] = [
    { name: 'cond', value: COND_NAMES[cond], known: true, description: COND_MEANINGS[cond] },
    { name: 'op', value: isPush ? 'PUSH = STMDB SP!, {regs}' : 'POP = LDMIA SP!, {regs}', known: true, description: '' },
    { name: 'regs', value: regListKnown ? formatRegList(regList) : '?', known: regListKnown, description: 'Register list' },
  ];

  const partial = (mask >>> 0) !== 0xFFFFFFFF;
  return makeResult(enc, mask, 'ldm-stm', fields, flags, partial);
}

// ─── LDM/STM ─────────────────────────────────────────────────────────────────

function partialLdmStm(op: string, cond: number, argsRaw: string): PartialResult {
  const isLoad = op.startsWith('LDM');
  const modeStr = op.slice(3).toUpperCase();
  const modeMap: Record<string, { P: number; U: number }> = {
    IA:{P:0,U:1}, IB:{P:1,U:1}, DA:{P:0,U:0}, DB:{P:1,U:0},
    FD: isLoad ? {P:0,U:1}:{P:1,U:0},
    FA: isLoad ? {P:1,U:0}:{P:0,U:1},
    '': {P:0,U:1},
  };
  const mode = modeMap[modeStr] ?? {P:0,U:1};

  let enc = 0, mask = 0;
  [enc, mask] = setBits(enc, mask, 31, 28, cond);
  [enc, mask] = setBits(enc, mask, 27, 25, 0b100);
  [enc, mask] = setBits(enc, mask, 24, 24, mode.P);
  [enc, mask] = setBits(enc, mask, 23, 23, mode.U);
  [enc, mask] = setBits(enc, mask, 20, 20, isLoad ? 1 : 0);

  const args = splitArgs(argsRaw);
  let rnNum: number | null = null;
  let regList = 0;
  let regListKnown = false;
  let wb = false;

  if (args.length >= 1) {
    let rnStr = args[0];
    wb = rnStr.endsWith('!');
    if (wb) rnStr = rnStr.slice(0, -1);
    rnNum = tryParseRegister(rnStr);
    if (rnNum !== null) {
      [enc, mask] = setBits(enc, mask, 19, 16, rnNum);
      [enc, mask] = setBits(enc, mask, 21, 21, wb ? 1 : 0);
    }
  }

  const listStr = args.slice(1).join(',');
  const brace = listStr.match(/\{([^}]*)\}/);
  if (brace) {
    regListKnown = true;
    for (const r of brace[1].split(',').map(s=>s.trim()).filter(Boolean)) {
      const n = tryParseRegister(r);
      if (n !== null) regList |= (1<<n);
    }
    [enc, mask] = setBits(enc, mask, 15, 0, regList);
  }

  const fields: FieldMeta[] = [
    condField(cond),
    fixedField('Type', 'type', 27, 25, 0b100, 'Block data transfer'),
    fixedField('P', 'P', 24, 24, mode.P, mode.P ? 'Pre-index' : 'Post-index'),
    fixedField('U', 'U', 23, 23, mode.U, mode.U ? 'Increment (up)' : 'Decrement (down)'),
    rnNum !== null
      ? singleBitField('W', 21, 'W', wb ? 1 : 0, v=>v?'Write-back Rn':'No write-back','')
      : unknownField('W', 'W', 21, 21, 'W', 'Write-back'),
    fixedField('L', 'L', 20, 20, isLoad?1:0, isLoad?'Load':'Store'),
    regField('Rn', 19, 16, 'Rn', rnNum, 'Base register'),
    regListKnown
      ? { name:'RegList',shortName:'regs',highBit:15,lowBit:0,color:'reglist' as FieldColor,value:regList,known:true,
          display:`0x${regList.toString(16).toUpperCase().padStart(4,'0')}`,description:'Register bitmask' }
      : unknownField('RegList','regs',15,0,'reglist','Register list bitmask'),
  ];

  const flags: FlagInfo[] = [
    { name:'cond', value:COND_NAMES[cond], known:true, description:COND_MEANINGS[cond] },
    { name:'op', value:`${op} — ${isLoad?'Load':'Store'} multiple (${modeStr||'IA'})`, known:true, description:'' },
    { name:'Rn', value:rnNum!==null?`${regName(rnNum)}${wb?'!':'`'}`:' ?', known:rnNum!==null, description:'Base address register' },
    { name:'regs', value:regListKnown?formatRegList(regList):'?', known:regListKnown, description:'Register list' },
  ];

  const partial = (mask>>>0)!==0xFFFFFFFF;
  return makeResult(enc, mask, 'ldm-stm', fields, flags, partial);
}

// ─── shift alias ─────────────────────────────────────────────────────────────

function partialShiftAlias(op: string, cond: number, sFlag: boolean, argsRaw: string): PartialResult {
  const shiftTypes: Record<string,number> = {LSL:0,LSR:1,ASR:2,ROR:3};
  const shiftType = shiftTypes[op];

  let enc = 0, mask = 0;
  [enc, mask] = setBits(enc, mask, 31, 28, cond);
  [enc, mask] = setBits(enc, mask, 27, 26, 0b00);
  [enc, mask] = setBits(enc, mask, 25, 25, 0); // I=0
  [enc, mask] = setBits(enc, mask, 24, 21, 0xD); // MOV opcode
  [enc, mask] = setBits(enc, mask, 19, 16, 0); // Rn=0 (SBZ)
  [enc, mask] = setBits(enc, mask, 6, 5, shiftType);

  const args = splitArgs(argsRaw);
  let rdNum: number|null=null, rmNum: number|null=null;

  if (args.length>=1 && (rdNum=tryParseRegister(args[0]))!==null) [enc,mask]=setBits(enc,mask,15,12,rdNum);
  if (args.length>=2 && (rmNum=tryParseRegister(args[1]))!==null) [enc,mask]=setBits(enc,mask,3,0,rmNum);
  if (args.length>=3) {
    const s = args[2];
    if (s.startsWith('#')||/^\d/.test(s)) {
      const amt=(tryParseImmediate(s)??0)&0x1F;
      [enc,mask]=setBits(enc,mask,11,7,amt);
      [enc,mask]=setBits(enc,mask,4,4,0);
    } else {
      const rs=tryParseRegister(s);
      if (rs!==null){ [enc,mask]=setBits(enc,mask,11,8,rs); [enc,mask]=setBits(enc,mask,4,4,1); }
    }
  }

  // Re-use data proc display with MOV + shift
  return partialDataProc('MOV', cond, sFlag, false,
    args.length>=3 ? `${args[0]}, ${args[1]}, ${SHIFT_NAMES[shiftType]} ${args[2]}` : argsRaw);
}

// ─── NOP ─────────────────────────────────────────────────────────────────────

function buildNopFields(cond: number): FieldMeta[] {
  return [
    condField(cond),
    fixedField('Type', 'type', 27, 26, 0b00, 'Data processing'),
    fixedField('I', 'I', 25, 25, 1, 'Immediate operand'),
    fixedField('op', 'op', 24, 21, 0b1101, 'MOV opcode'),
    fixedField('S', 'S', 20, 20, 0, 'No flag update'),
    fixedField('Rn (SBZ)', 'Rn', 19, 16, 0, 'Should be zero'),
    fixedField('Rd=R0', 'Rd', 15, 12, 0, 'Destination: R0'),
    fixedField('imm=0', 'imm', 11, 0, 0, 'Immediate: 0'),
  ];
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function formatRegList(regList: number): string {
  const regs: string[] = [];
  for (let i=0;i<16;i++) if (regList&(1<<i)) regs.push(regName(i));
  return regs.join(', ') || '(empty)';
}

function makeResult(enc: number, mask: number, instrType: InstrType, fields: FieldMeta[], flags: FlagInfo[], partial: boolean): PartialResult {
  enc = enc >>> 0;
  mask = mask >>> 0;
  const hexNibbles = Array.from({length:8}, (_,i)=>{
    const nibbleMask = 0xF << ((7-i)*4);
    if ((mask & nibbleMask) === nibbleMask) {
      return ((enc>>(7-i)*4)&0xF).toString(16).toUpperCase();
    }
    if ((mask & nibbleMask) === 0) return '?';
    return '~';
  });
  return { encoding: enc, mask, instrType, fields, flags, hex: '0x' + hexNibbles.join(''), partial };
}

function emptyResult(): PartialResult {
  return {
    encoding: 0, mask: 0, instrType: 'unknown',
    fields: [], flags: [], hex: '0x????????', partial: true,
  };
}

function unknownMnemResult(mnemonic: string, cond: number): PartialResult {
  return {
    encoding: (cond << 28) >>> 0,
    mask: 0xF0000000,
    instrType: 'unknown',
    fields: [condField(cond)],
    flags: [{ name: 'cond', value: COND_NAMES[cond], known: true, description: COND_MEANINGS[cond] }],
    hex: '0x????????',
    partial: true,
    mnemonic,
    error: `Unknown mnemonic: ${mnemonic}`,
  };
}
