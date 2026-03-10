// ARMv7 Assembler / Disassembler

const CONDS: Record<string, number> = {
  EQ: 0x0, NE: 0x1, CS: 0x2, HS: 0x2, CC: 0x3, LO: 0x3,
  MI: 0x4, PL: 0x5, VS: 0x6, VC: 0x7, HI: 0x8, LS: 0x9,
  GE: 0xA, LT: 0xB, GT: 0xC, LE: 0xD, AL: 0xE,
};

const COND_NAMES: string[] = [
  'EQ','NE','CS','CC','MI','PL','VS','VC','HI','LS','GE','LT','GT','LE','','NV',
];

const DATA_OP_CODES: Record<string, number> = {
  AND: 0x0, EOR: 0x1, SUB: 0x2, RSB: 0x3, ADD: 0x4, ADC: 0x5, SBC: 0x6, RSC: 0x7,
  TST: 0x8, TEQ: 0x9, CMP: 0xA, CMN: 0xB, ORR: 0xC, MOV: 0xD, BIC: 0xE, MVN: 0xF,
};

const DATA_OP_NAMES: string[] = [
  'AND','EOR','SUB','RSB','ADD','ADC','SBC','RSC',
  'TST','TEQ','CMP','CMN','ORR','MOV','BIC','MVN',
];

const TEST_OPS = new Set(['TST','TEQ','CMP','CMN']);
const MOVE_OPS = new Set(['MOV','MVN']);

function parseRegister(s: string): number {
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
  throw new Error(`Invalid register: ${s}`);
}

function encodeImmediate(value: number): number | null {
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

function parseImmediate(s: string): number {
  s = s.trim();
  if (s.startsWith('#')) s = s.slice(1);
  const neg = s.startsWith('-');
  if (neg) s = s.slice(1);
  let val: number;
  if (s.startsWith('0x') || s.startsWith('0X')) {
    val = parseInt(s, 16);
  } else {
    val = parseInt(s, 10);
  }
  return neg ? -val : val;
}

function encodeOperand2(operand: string): { encoding: number; isImmediate: boolean } {
  operand = operand.trim();
  if (operand.startsWith('#')) {
    const val = parseImmediate(operand);
    const enc = encodeImmediate(val >>> 0);
    if (enc === null) throw new Error(`Cannot encode immediate #${val} in ARM 12-bit form`);
    return { encoding: enc, isImmediate: true };
  }
  const commaIdx = operand.indexOf(',');
  const rmStr = commaIdx >= 0 ? operand.slice(0, commaIdx) : operand;
  const rm = parseRegister(rmStr);
  let shiftType = 0;
  let shiftAmt = 0;
  let shiftByReg = false;
  let rs = 0;

  if (commaIdx >= 0) {
    const shiftExpr = operand.slice(commaIdx + 1).trim();
    const m = shiftExpr.match(/^(LSL|LSR|ASR|ROR|RRX)\s*(.*)$/i);
    if (m) {
      const types: Record<string, number> = { LSL: 0, LSR: 1, ASR: 2, ROR: 3, RRX: 3 };
      shiftType = types[m[1].toUpperCase()];
      const shiftVal = m[2].trim();
      if (shiftVal === '' || m[1].toUpperCase() === 'RRX') {
        shiftAmt = 0;
      } else if (shiftVal.startsWith('#') || /^\d/.test(shiftVal)) {
        shiftAmt = parseImmediate(shiftVal);
      } else {
        rs = parseRegister(shiftVal);
        shiftByReg = true;
      }
    }
  }

  if (shiftByReg) {
    return { encoding: (rs << 8) | (shiftType << 5) | (1 << 4) | rm, isImmediate: false };
  } else {
    return { encoding: ((shiftAmt & 0x1F) << 7) | (shiftType << 5) | rm, isImmediate: false };
  }
}

export interface InstructionResult {
  address: number;
  binary: string;
  hex: string;
  encoding: number;
  error?: string;
}

function makeResult(encoding: number, address: number): InstructionResult {
  encoding = encoding >>> 0;
  return {
    address,
    encoding,
    binary: encoding.toString(2).padStart(32, '0'),
    hex: '0x' + encoding.toString(16).toUpperCase().padStart(8, '0'),
  };
}

function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inBracket = 0;
  let inBrace = 0;
  for (const ch of line) {
    if (ch === '[') { inBracket++; current += ch; }
    else if (ch === ']') { inBracket--; current += ch; }
    else if (ch === '{') { inBrace++; current += ch; }
    else if (ch === '}') { inBrace--; current += ch; }
    else if ((ch === ',' || ch === ' ' || ch === '\t') && inBracket === 0 && inBrace === 0) {
      if (current) { tokens.push(current); current = ''; }
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

const KNOWN_OPS = new Set([
  ...Object.keys(DATA_OP_CODES),
  'B','BL','BX','BLX','LDR','STR','LDRB','STRB','LDRH','STRH',
  'PUSH','POP','MUL','MLA','NOP','LSL','LSR','ASR','ROR',
  'LDMIA','LDMIB','LDMDA','LDMDB','STMIA','STMIB','STMDA','STMDB',
  'LDM','STM','STMFD','LDMFD',
]);

function isKnownOp(op: string): boolean {
  return KNOWN_OPS.has(op.toUpperCase());
}

function parseMnemonicCondS(mnemonic: string): { op: string; cond: number; sFlag: boolean } {
  let opBase = mnemonic.toUpperCase();
  let cond = 0xE;
  let sFlag = false;

  // Try to strip condition code (longest match first)
  const condKeys = Object.keys(CONDS).sort((a, b) => b.length - a.length);
  for (const condName of condKeys) {
    if (opBase.endsWith(condName)) {
      const base = opBase.slice(0, -condName.length);
      if (isKnownOp(base) || (base.endsWith('S') && isKnownOp(base.slice(0, -1)))) {
        cond = CONDS[condName];
        opBase = base;
        break;
      }
    }
  }

  // Strip S flag
  if (opBase.endsWith('S') && isKnownOp(opBase.slice(0, -1))) {
    sFlag = true;
    opBase = opBase.slice(0, -1);
  }

  return { op: opBase, cond, sFlag };
}

function encodeDataProcessing(op: string, args: string[], cond: number, sFlag: boolean, address: number): InstructionResult {
  const opcode = DATA_OP_CODES[op];
  const isTest = TEST_OPS.has(op);
  const isMove = MOVE_OPS.has(op);

  let rd = 0, rn = 0;
  let operandStr: string;

  if (isTest) {
    if (args.length < 2) throw new Error(`${op} requires 2 operands`);
    rn = parseRegister(args[0]);
    operandStr = args.slice(1).join(',');
  } else if (isMove) {
    if (args.length < 2) throw new Error(`${op} requires 2 operands`);
    rd = parseRegister(args[0]);
    operandStr = args.slice(1).join(',');
    rn = 0;
  } else {
    if (args.length < 3) throw new Error(`${op} requires 3 operands (Rd, Rn, Op2)`);
    rd = parseRegister(args[0]);
    rn = parseRegister(args[1]);
    operandStr = args.slice(2).join(',');
  }

  const { encoding: op2, isImmediate } = encodeOperand2(operandStr);
  const sBit = isTest ? 1 : (sFlag ? 1 : 0);

  const enc = (cond << 28) |
    (isImmediate ? (1 << 25) : 0) |
    (opcode << 21) |
    (sBit << 20) |
    (rn << 16) |
    (rd << 12) |
    op2;

  return makeResult(enc, address);
}

function encodeShiftAlias(op: string, args: string[], cond: number, sFlag: boolean, address: number): InstructionResult {
  if (args.length < 3) throw new Error(`${op} requires 3 operands (Rd, Rm, #shift)`);
  const rd = parseRegister(args[0]);
  const rm = parseRegister(args[1]);
  const shiftTypes: Record<string, number> = { LSL: 0, LSR: 1, ASR: 2, ROR: 3 };
  const shiftType = shiftTypes[op];

  let shiftEncoding: number;
  if (args[2].startsWith('#') || /^\d/.test(args[2])) {
    const amt = parseImmediate(args[2]) & 0x1F;
    shiftEncoding = (amt << 7) | (shiftType << 5) | rm;
  } else {
    const rs = parseRegister(args[2]);
    shiftEncoding = (rs << 8) | (shiftType << 5) | (1 << 4) | rm;
  }

  const enc = (cond << 28) |
    (0xD << 21) | // MOV
    ((sFlag ? 1 : 0) << 20) |
    (rd << 12) |
    shiftEncoding;

  return makeResult(enc, address);
}

function encodeBranch(op: string, args: string[], cond: number, address: number): InstructionResult {
  if (op === 'BX' || op === 'BLX') {
    if (args.length < 1) throw new Error(`${op} requires a register`);
    const rm = parseRegister(args[0]);
    const enc = op === 'BX'
      ? (cond << 28) | 0x012FFF10 | rm
      : (cond << 28) | 0x012FFF30 | rm;
    return makeResult(enc, address);
  }

  const link = op === 'BL' ? 1 : 0;
  if (args.length < 1) throw new Error(`${op} requires a target`);
  const targetStr = args[0];

  let byteOffset = 0;
  if (targetStr.startsWith('#') || /^-?\d/.test(targetStr) || targetStr.startsWith('0x')) {
    byteOffset = parseImmediate(targetStr);
  }
  // Subtract 8 for pipeline, divide by 4
  const pcRelOffset = Math.floor((byteOffset - 8) / 4);
  const encodedOffset = pcRelOffset & 0xFFFFFF;

  const enc = (cond << 28) | (0b101 << 25) | (link << 24) | encodedOffset;
  return makeResult(enc, address);
}

function encodeLoadStore(op: string, args: string[], cond: number, _sFlag: boolean, address: number): InstructionResult {
  const isByte = op.includes('B');
  const isHalf = op.includes('H');
  const isLoad = op.startsWith('LDR');

  if (args.length < 2) throw new Error(`${op} requires at least 2 operands`);
  const rd = parseRegister(args[0]);
  const addrExpr = args.slice(1).join(',');

  // Check for post-index: [Rn], #offset
  const postMatch = addrExpr.match(/^\[([^\]]+)\],\s*(.+)$/);
  const preMatch = addrExpr.match(/^\[([^\]]+)\](!?)$/);

  let preIndex: boolean;
  let writeback: boolean;
  let addrInner: string;
  let offsetStr: string | null = null;

  if (postMatch) {
    preIndex = false;
    writeback = false;
    addrInner = postMatch[1];
    offsetStr = postMatch[2];
  } else if (preMatch) {
    preIndex = true;
    writeback = preMatch[2] === '!';
    addrInner = preMatch[1];
  } else {
    throw new Error(`Invalid address expression: ${addrExpr}`);
  }

  const addrParts = addrInner.split(',').map(s => s.trim());
  const rn = parseRegister(addrParts[0]);

  if (addrParts.length > 1 && offsetStr === null) {
    offsetStr = addrParts.slice(1).join(',').trim();
  }

  let immFlag = 0;
  let up = 1;
  let offset12 = 0;
  let regEnc = 0;

  if (!offsetStr || offsetStr === '0' || offsetStr === '#0') {
    immFlag = 0;
    offset12 = 0;
  } else if (offsetStr.startsWith('#') || /^-?\d/.test(offsetStr)) {
    immFlag = 0;
    let val = parseImmediate(offsetStr);
    if (val < 0) { up = 0; val = -val; }
    offset12 = val & 0xFFF;
  } else {
    immFlag = 1;
    const negReg = offsetStr.startsWith('-');
    if (negReg) { up = 0; offsetStr = offsetStr.slice(1); }
    const { encoding } = encodeOperand2(offsetStr);
    regEnc = encoding;
  }

  if (isHalf) {
    // LDRH/STRH uses different encoding (halfword/byte)
    const enc = (cond << 28) |
      (preIndex ? (1 << 24) : 0) |
      (up << 23) |
      (immFlag === 0 ? (1 << 22) : 0) |
      (writeback || !preIndex ? (1 << 21) : 0) |
      (isLoad ? (1 << 20) : 0) |
      (rn << 16) |
      (rd << 12) |
      (!immFlag ? ((offset12 & 0xF0) << 4) | 0xB0 | (offset12 & 0xF) : 0xB0 | (regEnc & 0xF));
    return makeResult(enc, address);
  }

  const enc = (cond << 28) |
    (0b01 << 26) |
    (immFlag << 25) |
    (preIndex ? (1 << 24) : 0) |
    (up << 23) |
    (isByte ? (1 << 22) : 0) |
    ((writeback || !preIndex) ? (1 << 21) : 0) |
    (isLoad ? (1 << 20) : 0) |
    (rn << 16) |
    (rd << 12) |
    (immFlag ? regEnc : offset12);

  return makeResult(enc, address);
}

function encodePushPop(op: string, args: string[], cond: number, address: number): InstructionResult {
  const isPush = op === 'PUSH';
  const listStr = args.join(',');
  const braceMatch = listStr.match(/^\{([^}]+)\}$/);
  if (!braceMatch) throw new Error(`Invalid register list: ${listStr}`);

  const regs = braceMatch[1].split(',').map(s => s.trim());
  let regList = 0;
  for (const reg of regs) {
    const rangeMatch = reg.match(/^[Rr](\d+)-[Rr](\d+)$/);
    if (rangeMatch) {
      for (let i = parseInt(rangeMatch[1]); i <= parseInt(rangeMatch[2]); i++) regList |= (1 << i);
    } else {
      regList |= (1 << parseRegister(reg));
    }
  }

  let enc: number;
  if (isPush) {
    enc = (cond << 28) | (0b100 << 25) | (1 << 24) | (0 << 23) | (0 << 22) | (1 << 21) | (0 << 20) | (13 << 16) | regList;
  } else {
    enc = (cond << 28) | (0b100 << 25) | (0 << 24) | (1 << 23) | (0 << 22) | (1 << 21) | (1 << 20) | (13 << 16) | regList;
  }

  return makeResult(enc, address);
}

function encodeMul(op: string, args: string[], cond: number, sFlag: boolean, address: number): InstructionResult {
  if (op === 'MUL') {
    if (args.length < 3) throw new Error('MUL requires 3 operands (Rd, Rm, Rs)');
    const rd = parseRegister(args[0]);
    const rm = parseRegister(args[1]);
    const rs = parseRegister(args[2]);
    const enc = (cond << 28) | (sFlag ? (1 << 20) : 0) | (rd << 16) | (rs << 8) | 0x90 | rm;
    return makeResult(enc, address);
  } else {
    if (args.length < 4) throw new Error('MLA requires 4 operands (Rd, Rm, Rs, Rn)');
    const rd = parseRegister(args[0]);
    const rm = parseRegister(args[1]);
    const rs = parseRegister(args[2]);
    const rn = parseRegister(args[3]);
    const enc = (cond << 28) | (1 << 21) | (sFlag ? (1 << 20) : 0) | (rd << 16) | (rn << 12) | (rs << 8) | 0x90 | rm;
    return makeResult(enc, address);
  }
}

function encodeLdmStm(op: string, args: string[], cond: number, address: number): InstructionResult {
  const isLoad = op.startsWith('LDM');
  const modeStr = op.slice(3).toUpperCase();

  // STMFD = STMDB, LDMFD = LDMIA
  const modeMap: Record<string, { P: number; U: number }> = {
    IA: { P: 0, U: 1 }, IB: { P: 1, U: 1 }, DA: { P: 0, U: 0 }, DB: { P: 1, U: 0 },
    FD: isLoad ? { P: 0, U: 1 } : { P: 1, U: 0 },
    FA: isLoad ? { P: 1, U: 0 } : { P: 0, U: 1 },
    ED: isLoad ? { P: 1, U: 1 } : { P: 0, U: 0 },
    EA: isLoad ? { P: 0, U: 0 } : { P: 1, U: 1 },
    '': { P: 0, U: 1 },
  };

  const mode = modeMap[modeStr] ?? { P: 0, U: 1 };

  let rnStr = args[0];
  const writeback = rnStr.endsWith('!');
  if (writeback) rnStr = rnStr.slice(0, -1);
  const rn = parseRegister(rnStr);

  const listStr = args.slice(1).join(',');
  const braceMatch = listStr.match(/^\{([^}]+)\}$/);
  if (!braceMatch) throw new Error(`Invalid register list: ${listStr}`);

  const regs = braceMatch[1].split(',').map(s => s.trim());
  let regList = 0;
  for (const reg of regs) {
    const rangeMatch = reg.match(/^[Rr](\d+)-[Rr](\d+)$/);
    if (rangeMatch) {
      for (let i = parseInt(rangeMatch[1]); i <= parseInt(rangeMatch[2]); i++) regList |= (1 << i);
    } else {
      regList |= (1 << parseRegister(reg));
    }
  }

  const enc = (cond << 28) |
    (0b100 << 25) |
    (mode.P << 24) |
    (mode.U << 23) |
    ((writeback ? 1 : 0) << 21) |
    (isLoad ? (1 << 20) : 0) |
    (rn << 16) |
    regList;

  return makeResult(enc, address);
}

export function assembleInstruction(line: string, address: number = 0): InstructionResult {
  line = line.trim();
  const commentIdx = line.search(/[;@]/);
  if (commentIdx >= 0) line = line.slice(0, commentIdx).trim();
  if (!line) throw new Error('Empty line');

  // Strip label
  line = line.replace(/^[A-Za-z_][A-Za-z0-9_]*:\s*/, '').trim();
  if (!line) throw new Error('Label only');

  const tokens = tokenize(line);
  if (tokens.length === 0) throw new Error('Empty instruction');

  const { op, cond, sFlag } = parseMnemonicCondS(tokens[0]);
  const args = tokens.slice(1);

  if (op === 'NOP') {
    return makeResult((cond << 28) | 0x0320F000, address);
  }

  if (op === 'B' || op === 'BL' || op === 'BX' || op === 'BLX') {
    return encodeBranch(op, args, cond, address);
  }

  if (op === 'LDR' || op === 'STR' || op === 'LDRB' || op === 'STRB' || op === 'LDRH' || op === 'STRH') {
    return encodeLoadStore(op, args, cond, sFlag, address);
  }

  if (op === 'PUSH' || op === 'POP') {
    return encodePushPop(op, args, cond, address);
  }

  if (op === 'MUL' || op === 'MLA') {
    return encodeMul(op, args, cond, sFlag, address);
  }

  if (op in DATA_OP_CODES) {
    return encodeDataProcessing(op, args, cond, sFlag, address);
  }

  if (['LSL','LSR','ASR','ROR'].includes(op)) {
    return encodeShiftAlias(op, args, cond, sFlag, address);
  }

  if (op.startsWith('LDM') || op.startsWith('STM')) {
    return encodeLdmStm(op, args, cond, address);
  }

  throw new Error(`Unknown instruction: ${tokens[0]}`);
}

// ============================================================
// DISASSEMBLER
// ============================================================

function regName(n: number): string {
  if (n === 13) return 'SP';
  if (n === 14) return 'LR';
  if (n === 15) return 'PC';
  return `R${n}`;
}

function condSuffix(cond: number): string {
  return cond === 0xE ? '' : (COND_NAMES[cond] ?? '??');
}

function disassembleDataProcessing(enc: number, cs: string): string {
  const isImmediate = (enc >>> 25) & 1;
  const opcode = (enc >>> 21) & 0xF;
  const sFlag = (enc >>> 20) & 1;
  const rn = (enc >>> 16) & 0xF;
  const rd = (enc >>> 12) & 0xF;
  const op2 = enc & 0xFFF;

  const opName = DATA_OP_NAMES[opcode];
  const sSuffix = (sFlag && !TEST_OPS.has(opName)) ? 'S' : '';
  const isTest = TEST_OPS.has(opName);
  const isMove = MOVE_OPS.has(opName);

  let op2Str: string;
  if (isImmediate) {
    const rotate = ((op2 >>> 8) & 0xF) * 2;
    const imm8 = op2 & 0xFF;
    const value = rotate === 0 ? imm8 : ((imm8 >>> rotate) | (imm8 << (32 - rotate))) >>> 0;
    op2Str = `#${value}`;
  } else {
    const shiftType = (op2 >>> 5) & 3;
    const shiftTypeNames = ['LSL','LSR','ASR','ROR'];
    const byReg = (op2 >>> 4) & 1;
    const rm = op2 & 0xF;
    if (byReg) {
      const rs = (op2 >>> 8) & 0xF;
      op2Str = `${regName(rm)}, ${shiftTypeNames[shiftType]} ${regName(rs)}`;
    } else {
      const shiftAmt = (op2 >>> 7) & 0x1F;
      if (shiftAmt === 0 && shiftType === 0) {
        op2Str = regName(rm);
      } else if (shiftAmt === 0 && shiftType === 3) {
        op2Str = `${regName(rm)}, RRX`;
      } else {
        op2Str = `${regName(rm)}, ${shiftTypeNames[shiftType]} #${shiftAmt}`;
      }
    }
  }

  if (isTest) return `${opName}${cs} ${regName(rn)}, ${op2Str}`;
  if (isMove) return `${opName}${cs}${sSuffix} ${regName(rd)}, ${op2Str}`;
  return `${opName}${cs}${sSuffix} ${regName(rd)}, ${regName(rn)}, ${op2Str}`;
}

function disassembleLoadStore(enc: number, cs: string): string {
  const isReg = (enc >>> 25) & 1;
  const preIndex = (enc >>> 24) & 1;
  const up = (enc >>> 23) & 1;
  const isByte = (enc >>> 22) & 1;
  const writeback = (enc >>> 21) & 1;
  const isLoad = (enc >>> 20) & 1;
  const rn = (enc >>> 16) & 0xF;
  const rd = (enc >>> 12) & 0xF;
  const offset = enc & 0xFFF;

  const op = (isLoad ? 'LDR' : 'STR') + (isByte ? 'B' : '');
  const sign = up ? '' : '-';

  let addrStr: string;
  if (isReg) {
    const rm = offset & 0xF;
    const shiftType = (offset >>> 5) & 3;
    const shiftAmt = (offset >>> 7) & 0x1F;
    const shiftNames = ['LSL','LSR','ASR','ROR'];
    const regStr = shiftAmt > 0
      ? `${sign}${regName(rm)}, ${shiftNames[shiftType]} #${shiftAmt}`
      : `${sign}${regName(rm)}`;
    addrStr = preIndex
      ? `[${regName(rn)}, ${regStr}]${writeback ? '!' : ''}`
      : `[${regName(rn)}], ${regStr}`;
  } else {
    if (offset === 0) {
      addrStr = `[${regName(rn)}]`;
    } else {
      const offsetStr = `#${sign}${offset}`;
      addrStr = preIndex
        ? `[${regName(rn)}, ${offsetStr}]${writeback ? '!' : ''}`
        : `[${regName(rn)}], ${offsetStr}`;
    }
  }

  return `${op}${cs} ${regName(rd)}, ${addrStr}`;
}

function disassembleLdmStm(enc: number, cs: string): string {
  const preIndex = (enc >>> 24) & 1;
  const up = (enc >>> 23) & 1;
  const writeback = (enc >>> 21) & 1;
  const isLoad = (enc >>> 20) & 1;
  const rn = (enc >>> 16) & 0xF;
  const regList = enc & 0xFFFF;
  const regs = decodeRegList(regList);

  if (rn === 13 && writeback) {
    if (!isLoad && preIndex && !up) {
      return `PUSH${cs} {${regs}}`;
    }
    if (isLoad && !preIndex && up) {
      return `POP${cs} {${regs}}`;
    }
  }

  const mode = up ? (preIndex ? 'IB' : 'IA') : (preIndex ? 'DB' : 'DA');
  const op = (isLoad ? 'LDM' : 'STM') + mode;
  return `${op}${cs} ${regName(rn)}${writeback ? '!' : ''}, {${regs}}`;
}

function decodeRegList(regList: number): string {
  const regs: string[] = [];
  for (let i = 0; i < 16; i++) {
    if (regList & (1 << i)) regs.push(regName(i));
  }
  return regs.join(', ');
}

function disassembleMul(enc: number, cs: string): string {
  const isAccumulate = (enc >>> 21) & 1;
  const sFlag = (enc >>> 20) & 1;
  const rd = (enc >>> 16) & 0xF;
  const rn = (enc >>> 12) & 0xF;
  const rs = (enc >>> 8) & 0xF;
  const rm = enc & 0xF;
  const s = sFlag ? 'S' : '';

  if (isAccumulate) {
    return `MLA${cs}${s} ${regName(rd)}, ${regName(rm)}, ${regName(rs)}, ${regName(rn)}`;
  }
  return `MUL${cs}${s} ${regName(rd)}, ${regName(rm)}, ${regName(rs)}`;
}

export function disassembleInstruction(encoding: number): string {
  encoding = encoding >>> 0;

  const cond = (encoding >>> 28) & 0xF;
  const cs = condSuffix(cond);

  if (cond === 0xF) {
    return `; Unconditional (ARMv6+): 0x${encoding.toString(16).toUpperCase().padStart(8,'0')}`;
  }

  // NOP
  if (encoding === ((cond << 28) | 0x0320F000)) return `NOP${cs}`;
  // Also handle MOV R0, R0 as NOP
  if (encoding === ((cond << 28) | 0x01A00000)) return `NOP${cs} ; MOV R0, R0`;

  const bits27_25 = (encoding >>> 25) & 0x7;
  const bits27_26 = (encoding >>> 26) & 0x3;

  // Branch: 101x
  if (bits27_25 === 0b101) {
    const link = (encoding >>> 24) & 1;
    const offset24 = encoding & 0xFFFFFF;
    const signed = offset24 >= 0x800000 ? offset24 - 0x1000000 : offset24;
    const byteOffset = signed * 4 + 8;
    const op = link ? 'BL' : 'B';
    return `${op}${cs} #${byteOffset >= 0 ? '+' : ''}${byteOffset}`;
  }

  // BX / BLX register
  if ((encoding & 0x0FFFFFF0) === 0x012FFF10) {
    return `BX${cs} ${regName(encoding & 0xF)}`;
  }
  if ((encoding & 0x0FFFFFF0) === 0x012FFF30) {
    return `BLX${cs} ${regName(encoding & 0xF)}`;
  }

  // LDM/STM: 100x
  if (bits27_25 === 0b100) {
    return disassembleLdmStm(encoding, cs);
  }

  // Load/Store: 01xx
  if (bits27_26 === 0b01) {
    return disassembleLoadStore(encoding, cs);
  }

  // MUL/MLA: 000000xx...1001xxxx
  if ((encoding & 0x0FC000F0) === 0x00000090) {
    return disassembleMul(encoding, cs);
  }

  // Data processing: 00xx
  if (bits27_26 === 0b00) {
    return disassembleDataProcessing(encoding, cs);
  }

  return `; Unknown: 0x${encoding.toString(16).toUpperCase().padStart(8,'0')}`;
}

// ============================================================
// Public multi-line API
// ============================================================

export interface AssemblyLine {
  lineNumber: number;
  source: string;
  encoding?: number;
  binary?: string;
  hex?: string;
  asm?: string;
  error?: string;
  isComment?: boolean;
  isEmpty?: boolean;
}

export function assembleMultiple(text: string): AssemblyLine[] {
  const lines = text.split('\n');
  const results: AssemblyLine[] = [];
  let address = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const stripped = line.trim().replace(/\s+/g, ' ');

    if (!stripped) {
      results.push({ lineNumber: i + 1, source: line, isEmpty: true });
      continue;
    }

    const withoutLabel = stripped.replace(/^[A-Za-z_][A-Za-z0-9_]*:\s*/, '').trim();
    if (!withoutLabel || withoutLabel.startsWith(';') || withoutLabel.startsWith('@')) {
      results.push({ lineNumber: i + 1, source: line, isComment: true });
      continue;
    }

    try {
      const result = assembleInstruction(stripped, address);
      results.push({
        lineNumber: i + 1,
        source: line,
        encoding: result.encoding,
        binary: result.binary,
        hex: result.hex,
      });
      address += 4;
    } catch (err) {
      results.push({
        lineNumber: i + 1,
        source: line,
        error: (err as Error).message,
      });
    }
  }

  return results;
}

export function disassembleMultiple(text: string): AssemblyLine[] {
  const lines = text.split('\n');
  const results: AssemblyLine[] = [];
  let address = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim().replace(/\s+/g, '');

    if (!trimmed) {
      results.push({ lineNumber: i + 1, source: line, isEmpty: true });
      continue;
    }

    try {
      let encoding: number;
      if (/^[01]{32}$/.test(trimmed)) {
        encoding = parseInt(trimmed, 2) >>> 0;
      } else if (/^(0x|0X)?[0-9A-Fa-f]{1,8}$/.test(trimmed)) {
        encoding = parseInt(trimmed.replace(/^0[xX]/, ''), 16) >>> 0;
      } else {
        throw new Error(`Expected 32-bit binary or hex value`);
      }

      const asm = disassembleInstruction(encoding);
      const binary = encoding.toString(2).padStart(32, '0');
      const hex = '0x' + encoding.toString(16).toUpperCase().padStart(8, '0');

      results.push({
        lineNumber: i + 1,
        source: line,
        encoding,
        binary,
        hex,
        asm,
        error: asm.startsWith(';') ? asm : undefined,
      });
      address += 4;
    } catch (err) {
      results.push({
        lineNumber: i + 1,
        source: line,
        error: (err as Error).message,
      });
    }
  }

  return results;
}
