import { useState, useMemo, useRef, useEffect } from 'react'
import { Cpu, Info, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { partialAssemble, type PartialResult, type FieldMeta, type FieldColor } from '@/lib/armv7-partial'
import { disassembleInstruction } from '@/lib/armv7'

// ─── colour palette ───────────────────────────────────────────────────────────

const COLORS: Record<FieldColor, { box: string; border: string; text: string; label: string; badgeBg: string; badgeText: string }> = {
  cond:             { box:'bg-rose-950/60',      border:'border-rose-700/60',    text:'text-rose-300',    label:'text-rose-400',    badgeBg:'bg-rose-900/30',    badgeText:'text-rose-300'    },
  type:             { box:'bg-zinc-800/50',       border:'border-zinc-600/40',    text:'text-zinc-400',    label:'text-zinc-500',    badgeBg:'bg-zinc-800/30',    badgeText:'text-zinc-400'    },
  I:                { box:'bg-amber-950/60',      border:'border-amber-700/60',   text:'text-amber-300',   label:'text-amber-400',   badgeBg:'bg-amber-900/30',   badgeText:'text-amber-300'   },
  opcode:           { box:'bg-orange-950/60',     border:'border-orange-700/60',  text:'text-orange-300',  label:'text-orange-400',  badgeBg:'bg-orange-900/30',  badgeText:'text-orange-300'  },
  S:                { box:'bg-yellow-950/60',     border:'border-yellow-700/60',  text:'text-yellow-300',  label:'text-yellow-400',  badgeBg:'bg-yellow-900/30',  badgeText:'text-yellow-300'  },
  Rn:               { box:'bg-emerald-950/60',    border:'border-emerald-700/60', text:'text-emerald-300', label:'text-emerald-400', badgeBg:'bg-emerald-900/30', badgeText:'text-emerald-300' },
  Rd:               { box:'bg-sky-950/60',        border:'border-sky-700/60',     text:'text-sky-300',     label:'text-sky-400',     badgeBg:'bg-sky-900/30',     badgeText:'text-sky-300'     },
  op2:              { box:'bg-violet-950/60',     border:'border-violet-700/60',  text:'text-violet-300',  label:'text-violet-400',  badgeBg:'bg-violet-900/30',  badgeText:'text-violet-300'  },
  'op2-rot':        { box:'bg-fuchsia-950/60',    border:'border-fuchsia-700/60', text:'text-fuchsia-300', label:'text-fuchsia-400', badgeBg:'bg-fuchsia-900/30', badgeText:'text-fuchsia-300' },
  'op2-imm':        { box:'bg-purple-950/60',     border:'border-purple-700/60',  text:'text-purple-300',  label:'text-purple-400',  badgeBg:'bg-purple-900/30',  badgeText:'text-purple-300'  },
  'op2-shift-amt':  { box:'bg-indigo-950/60',     border:'border-indigo-700/60',  text:'text-indigo-300',  label:'text-indigo-400',  badgeBg:'bg-indigo-900/30',  badgeText:'text-indigo-300'  },
  'op2-shift-type': { box:'bg-blue-950/60',       border:'border-blue-700/60',    text:'text-blue-300',    label:'text-blue-400',    badgeBg:'bg-blue-900/30',    badgeText:'text-blue-300'    },
  'op2-rs':         { box:'bg-cyan-950/60',       border:'border-cyan-700/60',    text:'text-cyan-300',    label:'text-cyan-400',    badgeBg:'bg-cyan-900/30',    badgeText:'text-cyan-300'    },
  'op2-rm':         { box:'bg-teal-950/60',       border:'border-teal-700/60',    text:'text-teal-300',    label:'text-teal-400',    badgeBg:'bg-teal-900/30',    badgeText:'text-teal-300'    },
  L:                { box:'bg-lime-950/60',       border:'border-lime-700/60',    text:'text-lime-300',    label:'text-lime-400',    badgeBg:'bg-lime-900/30',    badgeText:'text-lime-300'    },
  offset:           { box:'bg-green-950/60',      border:'border-green-700/60',   text:'text-green-300',   label:'text-green-400',   badgeBg:'bg-green-900/30',   badgeText:'text-green-300'   },
  fixed:            { box:'bg-zinc-900/40',       border:'border-zinc-700/40',    text:'text-zinc-500',    label:'text-zinc-600',    badgeBg:'bg-zinc-900/20',    badgeText:'text-zinc-500'    },
  P:                { box:'bg-stone-900/50',      border:'border-stone-600/50',   text:'text-stone-300',   label:'text-stone-400',   badgeBg:'bg-stone-900/30',   badgeText:'text-stone-300'   },
  U:                { box:'bg-neutral-800/50',    border:'border-neutral-600/50', text:'text-neutral-300', label:'text-neutral-400', badgeBg:'bg-neutral-800/30', badgeText:'text-neutral-300' },
  B:                { box:'bg-red-950/60',        border:'border-red-700/60',     text:'text-red-300',     label:'text-red-400',     badgeBg:'bg-red-900/30',     badgeText:'text-red-300'     },
  W:                { box:'bg-pink-950/60',       border:'border-pink-700/60',    text:'text-pink-300',    label:'text-pink-400',    badgeBg:'bg-pink-900/30',    badgeText:'text-pink-300'    },
  A:                { box:'bg-yellow-900/40',     border:'border-yellow-600/50',  text:'text-yellow-200',  label:'text-yellow-300',  badgeBg:'bg-yellow-900/20',  badgeText:'text-yellow-200'  },
  reglist:          { box:'bg-violet-900/40',     border:'border-violet-600/50',  text:'text-violet-200',  label:'text-violet-300',  badgeBg:'bg-violet-900/20',  badgeText:'text-violet-200'  },
  unknown:          { box:'bg-zinc-950/40',       border:'border-zinc-700/20',    text:'text-zinc-700',    label:'text-zinc-700',    badgeBg:'bg-zinc-900/10',    badgeText:'text-zinc-700'    },
}

function getColor(c: FieldColor) { return COLORS[c] ?? COLORS.unknown }

// ─── Dropdown option maps ────────────────────────────────────────────────────

const REG_OPTIONS = Array.from({ length: 16 }, (_, i) => ({
  label: i === 13 ? 'SP  (R13)' : i === 14 ? 'LR  (R14)' : i === 15 ? 'PC  (R15)' : `R${i}`,
  value: i,
}))

const DROPDOWN_OPTIONS: Record<string, { label: string; value: number }[]> = {
  cond: [
    { label: 'EQ — Equal (Z=1)',               value:  0 },
    { label: 'NE — Not equal (Z=0)',            value:  1 },
    { label: 'CS/HS — Carry set (C=1)',         value:  2 },
    { label: 'CC/LO — Carry clear (C=0)',       value:  3 },
    { label: 'MI — Minus / negative (N=1)',     value:  4 },
    { label: 'PL — Plus / positive (N=0)',      value:  5 },
    { label: 'VS — Overflow (V=1)',             value:  6 },
    { label: 'VC — No overflow (V=0)',          value:  7 },
    { label: 'HI — Unsigned higher (C=1,Z=0)', value:  8 },
    { label: 'LS — Unsigned ≤ (C=0 or Z=1)',   value:  9 },
    { label: 'GE — Signed ≥ (N=V)',            value: 10 },
    { label: 'LT — Signed < (N≠V)',            value: 11 },
    { label: 'GT — Signed > (Z=0, N=V)',       value: 12 },
    { label: 'LE — Signed ≤ (Z=1 or N≠V)',     value: 13 },
    { label: 'AL — Always (unconditional)',     value: 14 },
    { label: 'NV — Never (legacy)',             value: 15 },
  ],
  op: [
    { label: 'AND — Rd = Rn AND Op2',   value:  0 },
    { label: 'EOR — Rd = Rn EOR Op2',   value:  1 },
    { label: 'SUB — Rd = Rn − Op2',     value:  2 },
    { label: 'RSB — Rd = Op2 − Rn',     value:  3 },
    { label: 'ADD — Rd = Rn + Op2',     value:  4 },
    { label: 'ADC — Rd = Rn + Op2 + C', value:  5 },
    { label: 'SBC — Rd = Rn − Op2 + C', value:  6 },
    { label: 'RSC — Rd = Op2 − Rn + C', value:  7 },
    { label: 'TST — flags Rn AND Op2',  value:  8 },
    { label: 'TEQ — flags Rn EOR Op2',  value:  9 },
    { label: 'CMP — flags Rn − Op2',    value: 10 },
    { label: 'CMN — flags Rn + Op2',    value: 11 },
    { label: 'ORR — Rd = Rn OR Op2',    value: 12 },
    { label: 'MOV — Rd = Op2',          value: 13 },
    { label: 'BIC — Rn AND NOT Op2',    value: 14 },
    { label: 'MVN — Rd = NOT Op2',      value: 15 },
  ],
  Rd: REG_OPTIONS,
  Rn: REG_OPTIONS,
  Rs: REG_OPTIONS,
  Rm: REG_OPTIONS,
  I:  [{ label: '0 — Register operand',   value: 0 }, { label: '1 — Immediate operand', value: 1 }],
  S:  [{ label: '0 — No flag update',     value: 0 }, { label: '1 — Update CPSR flags', value: 1 }],
  L:  [{ label: '0 — Store (STR / STM)',  value: 0 }, { label: '1 — Load (LDR / LDM)',  value: 1 }],
  A:  [{ label: '0 — Multiply (MUL)',     value: 0 }, { label: '1 — Multiply-Acc (MLA)', value: 1 }],
  U:  [{ label: '0 — Down (subtract)',    value: 0 }, { label: '1 — Up (add offset)',    value: 1 }],
  P:  [{ label: '0 — Post-index',         value: 0 }, { label: '1 — Pre-index',          value: 1 }],
  W:  [{ label: '0 — No writeback',       value: 0 }, { label: '1 — Writeback (!)',       value: 1 }],
  B:  [{ label: '0 — Word transfer',      value: 0 }, { label: '1 — Byte transfer',      value: 1 }],
  shift: [
    { label: 'LSL — Logical Shift Left',     value: 0 },
    { label: 'LSR — Logical Shift Right',    value: 1 },
    { label: 'ASR — Arithmetic Shift Right', value: 2 },
    { label: 'ROR — Rotate Right',           value: 3 },
  ],
}

// ─── Apply flag change → rebuild instruction string ──────────────────────────

function applyFlagChange(result: PartialResult, fieldShortName: string, newValue: number): string {
  const field = result.fields.find(f => f.shortName === fieldShortName)
  if (!field) return ''
  const width = field.highBit - field.lowBit + 1
  const bits = (newValue & ((1 << width) - 1)) >>> 0
  const fieldMask = (((1 << width) - 1) << field.lowBit) >>> 0
  const newEnc = ((result.encoding & ~fieldMask) | (bits << field.lowBit)) >>> 0
  return disassembleInstruction(newEnc)
}

// ─── BitBox ───────────────────────────────────────────────────────────────────

function BitBox({ bit, encoding, mask, color, hovered }: {
  bit: number; encoding: number; mask: number; color: FieldColor; hovered: boolean
}) {
  const isKnown = (mask >>> bit) & 1
  const value   = (encoding >>> bit) & 1
  const c       = getColor(color)

  return (
    <div className={cn(
      'w-6 h-7 flex items-center justify-center rounded border font-mono text-sm font-bold',
      'transition-all duration-100',
      c.box, c.border,
      hovered && 'ring-1 ring-white/40 brightness-125',
      !isKnown && 'opacity-25',
    )}>
      {isKnown
        ? <span className={c.text}>{value}</span>
        : <span className="text-zinc-600 text-xs">·</span>
      }
    </div>
  )
}

// ─── FieldGroup — grouped bit boxes + bracket label for one field ────────────

function FieldGroup({ field, encoding, mask, hovered, onHover }: {
  field: FieldMeta; encoding: number; mask: number; hovered: string | null; onHover: (n: string | null) => void
}) {
  const c = getColor(field.color)
  const isFocused = hovered === field.shortName
  const width = field.highBit - field.lowBit + 1
  const bits = Array.from({ length: width }, (_, i) => field.highBit - i)

  return (
    <div
      className={cn('flex flex-col items-center cursor-default select-none transition-all duration-100', isFocused && 'scale-105')}
      onMouseEnter={() => onHover(field.shortName)}
      onMouseLeave={() => onHover(null)}
    >
      {/* Bit index labels — show first and last */}
      <div className="flex gap-0.5">
        {bits.map((bit, idx) => {
          const show = idx === 0 || (width > 1 && idx === bits.length - 1)
          return (
            <div key={bit} className="w-6 flex justify-center">
              <span className={cn(
                'text-[9px] font-mono leading-none transition-colors',
                show ? (isFocused ? 'text-white' : 'text-zinc-600') : 'text-transparent',
              )}>
                {bit}
              </span>
            </div>
          )
        })}
      </div>

      {/* Bit boxes */}
      <div className="flex gap-0.5 mt-0.5">
        {bits.map(bit => (
          <BitBox key={bit} bit={bit} encoding={encoding} mask={mask} color={field.color} hovered={isFocused} />
        ))}
      </div>

      {/* Bracket label — use self-stretch so it spans the full width of the bit boxes */}
      <div className="flex flex-col items-center mt-1 self-stretch">
        <div className="relative h-3" style={{ width: '100%' }}>
          <div className={cn('absolute top-0 left-0 right-0 h-px opacity-40', c.label)} style={{ background: 'currentColor' }} />
          {width > 1 && <>
            <div className={cn('absolute left-0 top-0 w-px h-2 opacity-60', c.label)} style={{ background: 'currentColor' }} />
            <div className={cn('absolute right-0 top-0 w-px h-2 opacity-60', c.label)} style={{ background: 'currentColor' }} />
          </>}
        </div>
        <span className={cn('text-[10px] font-mono font-semibold whitespace-nowrap leading-none', c.label, isFocused && 'text-white')}>
          {field.shortName}
        </span>
        <span className={cn('text-[9px] text-zinc-600 font-mono mt-0.5 whitespace-nowrap', isFocused && 'text-zinc-400')}>
          [{field.highBit}{field.highBit !== field.lowBit ? `:${field.lowBit}` : ''}]
        </span>
      </div>
    </div>
  )
}

// ─── field colour per flag name ───────────────────────────────────────────────

const FLAG_COLORS: Record<string, FieldColor> = {
  cond: 'cond', op: 'opcode', opcode: 'opcode',
  I: 'I', S: 'S', Rd: 'Rd', Rn: 'Rn', Rs: 'op2-rs', Rm: 'op2-rm',
  imm: 'op2-imm', shift: 'op2-shift-amt', rot: 'op2-rot',
  L: 'L', offset: 'offset', regs: 'reglist',
  A: 'A', P: 'P', U: 'U', B: 'B', W: 'W',
}

// ─── Examples ─────────────────────────────────────────────────────────────────

const EXAMPLES = [
  'MOV R0, #42',   'ADD R1, R0, R2', 'ADDS R3, R1, #255',
  'SUB R0, R1, R2','CMP R0, #0',     'CMPEQ R0, R1',
  'B #+16',        'BL #+64',        'BX LR',
  'LDR R0, [R1, #4]', 'STR R2, [SP, #-8]!', 'LDRB R0, [R1]',
  'PUSH {R4, LR}', 'POP {R4, PC}',
  'MUL R0, R1, R2','MLA R0, R1, R2, R3',
  'MOV R1, R0, LSL #2', 'MOV R2, R3, ROR #4',
  'LDMIA R0!, {R1-R4}', 'STMFD SP!, {R4-R11, LR}',
  'NOP', 'MOVEQ R0, #1', 'ANDNE R5, R5, #0xFF',
]

// ─── FlagRow — single flag with dropdown ─────────────────────────────────────

function FlagRow({ flag, field, result, onChange }: {
  flag: { name: string; value: string; known: boolean; description: string }
  field: FieldMeta | undefined
  result: PartialResult
  onChange: (newInstruction: string) => void
}) {
  const [open, setOpen] = useState(false)
  const color  = FLAG_COLORS[flag.name] ?? 'unknown'
  const c      = getColor(color)
  const opts   = DROPDOWN_OPTIONS[flag.name]
  const canEdit = !!opts && !!field

  const numericVal = field?.value ?? -1

  function handleSelect(val: number) {
    const newInstr = applyFlagChange(result, flag.name, val)
    if (newInstr) onChange(newInstr)
    setOpen(false)
  }

  const wrapRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])

  return (
    <div className="flex items-start gap-3 px-3 py-2 rounded-lg hover:bg-zinc-800/30 transition-colors">
      <span className={cn(
        'shrink-0 font-mono text-xs font-bold px-1.5 py-0.5 rounded border w-14 text-center mt-0.5',
        c.badgeBg, c.badgeText, c.border,
        !flag.known && 'opacity-35',
      )}>
        {flag.name}
      </span>
      <div className="flex-1 min-w-0">
        {canEdit ? (
          <div className="relative" ref={wrapRef}>
            <button
              onClick={() => setOpen(v => !v)}
              className={cn(
                'flex items-center gap-1.5 w-full text-left rounded-md px-2 py-1',
                'text-sm font-mono transition-colors border',
                flag.known
                  ? `${c.badgeText} ${c.badgeBg} ${c.border} hover:brightness-125`
                  : 'text-zinc-600 bg-zinc-900/40 border-zinc-800/40 hover:bg-zinc-800/40',
              )}
            >
              <span className="flex-1 truncate">
                {flag.known
                  ? (opts.find(o => o.value === numericVal)?.label ?? flag.value)
                  : '— select —'}
              </span>
              <ChevronDown className={cn('size-3 shrink-0 transition-transform', open && 'rotate-180')} />
            </button>
            {open && (
              <div className="absolute left-0 right-0 top-full mt-1 bg-zinc-900 border border-zinc-700/60 rounded-xl shadow-2xl overflow-hidden z-50">
                <div className="max-h-56 overflow-y-auto scrollbar-thin">
                  {opts.map(opt => (
                    <button
                      key={opt.value}
                      onClick={() => handleSelect(opt.value)}
                      className={cn(
                        'w-full text-left px-3 py-2 font-mono text-xs transition-colors',
                        opt.value === numericVal && flag.known
                          ? `${c.badgeBg} ${c.badgeText} font-bold`
                          : 'text-zinc-300 hover:bg-zinc-800 hover:text-white',
                      )}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className={cn('text-sm font-mono px-2 py-1', flag.known ? 'text-zinc-200' : 'text-zinc-600 italic')}>
            {flag.known ? flag.value : '—'}
          </div>
        )}
        {flag.description && (
          <div className="text-[11px] text-zinc-600 mt-0.5 px-2 leading-snug">{flag.description}</div>
        )}
      </div>
    </div>
  )
}

// ─── App ─────────────────────────────────────────────────────────────────────

export default function App() {
  const [input, setInput] = useState('MOV R0, #42')
  const [hovered, setHovered] = useState<string | null>(null)
  const [showExamples, setShowExamples] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const result: PartialResult = useMemo(() => partialAssemble(input), [input])

  // deduplicated fields for rendering
  const fieldsForGroups = useMemo(() => {
    const seen = new Set<string>()
    return result.fields.filter(f => {
      const k = `${f.highBit}-${f.lowBit}`
      if (seen.has(k)) return false
      seen.add(k); return true
    })
  }, [result.fields])

  // field lookup for flags dropdowns
  const fieldByShortName = useMemo(() => {
    const m = new Map<string, FieldMeta>()
    result.fields.forEach(f => m.set(f.shortName, f))
    return m
  }, [result.fields])

  // close examples on outside click
  useEffect(() => {
    if (!showExamples) return
    const h = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest('[data-examples]')) setShowExamples(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [showExamples])

  const hexDisplay = `0x ${result.hex.slice(2,6)} ${result.hex.slice(6)}`

  const hoveredField = hovered ? result.fields.find(f => f.shortName === hovered) : null

  return (
    <div className="flex flex-col h-screen bg-zinc-950 text-zinc-100 overflow-hidden">

      {/* ── Header ───────────────────────────────────────────────────────── */}
      <header className="shrink-0 flex items-center gap-3 px-6 py-3 border-b border-zinc-800/80 bg-zinc-900/50">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-lg bg-blue-500/10 border border-blue-500/20">
            <Cpu className="size-4 text-blue-400" />
          </div>
          <div>
            <h1 className="text-sm font-bold leading-none">ARMv7 Instruction Encoder</h1>
            <p className="text-[11px] text-zinc-500 mt-0.5">visualise · learn · decode</p>
          </div>
        </div>

        <div className="ml-auto flex items-center gap-2">
          {result.error && (
            <span className="text-xs font-mono px-2 py-0.5 rounded border text-red-400 bg-red-900/20 border-red-800/40">
              {result.error}
            </span>
          )}
          {!result.error && (
            <span className={cn(
              'text-xs font-mono px-2 py-0.5 rounded border',
              result.partial
                ? 'text-amber-300 bg-amber-950/30 border-amber-800/40'
                : 'text-emerald-300 bg-emerald-950/30 border-emerald-800/40',
            )}>
              {result.partial ? 'partial' : 'complete'}
            </span>
          )}
          <span className={cn(
            'text-sm font-mono font-bold px-3 py-1 rounded-lg border tracking-widest',
            result.partial
              ? 'text-amber-200 bg-amber-950/20 border-amber-800/30'
              : 'text-emerald-200 bg-emerald-950/20 border-emerald-800/30',
          )}>
            {hexDisplay}
          </span>
        </div>
      </header>

      {/* ── Instruction input ────────────────────────────────────────────── */}
      <div className="shrink-0 px-6 pt-5 pb-4 border-b border-zinc-800/60">
        <div className="flex items-center gap-3">
          <div className="relative flex-1">
            <span className="absolute left-4 top-1/2 -translate-y-1/2 text-xs text-zinc-600 font-mono pointer-events-none select-none">
              asm
            </span>
            <input
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => e.key === 'Escape' && setInput('')}
              spellCheck={false}
              autoComplete="off"
              placeholder="Type an ARMv7 mnemonic…  e.g. ADD"
              className={cn(
                'w-full rounded-xl border bg-zinc-900/80 pl-14 pr-6 py-3.5',
                'font-mono text-2xl font-semibold text-zinc-100 tracking-wide',
                'placeholder:text-zinc-700 placeholder:font-normal placeholder:text-lg placeholder:tracking-normal',
                'outline-none transition-colors duration-150',
                result.error
                  ? 'border-red-800/60 focus:border-red-600/70'
                  : result.partial
                    ? 'border-zinc-700/50 focus:border-amber-700/60'
                    : 'border-emerald-800/50 focus:border-emerald-600/70',
              )}
            />
          </div>

          <div className="relative shrink-0" data-examples>
            <button
              onClick={() => setShowExamples(v => !v)}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-zinc-800/60 border border-zinc-700/50 text-zinc-400 hover:bg-zinc-700/60 hover:text-zinc-200 transition-colors"
            >
              <Info className="size-3.5" />
              Examples
            </button>
            {showExamples && (
              <div className="absolute right-0 top-full mt-2 w-60 bg-zinc-900 border border-zinc-700/60 rounded-xl shadow-2xl overflow-hidden z-50">
                <div className="max-h-72 overflow-y-auto">
                  {EXAMPLES.map(ex => (
                    <button
                      key={ex}
                      onClick={() => { setInput(ex); setShowExamples(false); inputRef.current?.focus() }}
                      className="w-full text-left px-4 py-2 font-mono text-sm text-zinc-300 hover:bg-zinc-800 hover:text-white transition-colors"
                    >
                      {ex}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Centred & Grouped Bit Boxes ──────────────────────────────────── */}
      <div className="shrink-0 px-6 pt-5 pb-4 border-b border-zinc-800/60 bg-zinc-950/60 overflow-x-auto">
        {fieldsForGroups.length === 0 ? (
          <div className="flex items-center justify-center gap-3 py-8 text-zinc-700">
            <Cpu className="size-5 opacity-20" />
            <span className="text-sm">Start typing an ARM instruction above</span>
          </div>
        ) : (
          <div className="flex items-start justify-center gap-3">
            {fieldsForGroups.map(field => (
              <FieldGroup
                key={`${field.shortName}-${field.highBit}`}
                field={field}
                encoding={result.encoding}
                mask={result.mask}
                hovered={hovered}
                onHover={setHovered}
              />
            ))}
          </div>
        )}
      </div>

      {/* ── Hover detail banner ──────────────────────────────────────────── */}
      <div className={cn(
        'shrink-0 border-b border-zinc-800/60 overflow-hidden transition-all duration-200',
        hoveredField ? 'max-h-16 opacity-100' : 'max-h-0 opacity-0',
      )}>
        {hoveredField && (() => {
          const f = hoveredField
          const c = getColor(f.color)
          return (
            <div className="flex items-center gap-4 px-6 py-3 bg-zinc-900/80">
              <span className={cn('font-mono text-xs font-bold px-2 py-1 rounded border shrink-0', c.badgeBg, c.badgeText, c.border)}>
                {f.shortName}
              </span>
              <span className="text-sm text-zinc-300 font-medium">{f.name}</span>
              <span className="text-xs text-zinc-500 flex-1">{f.description}</span>
              <div className="shrink-0 flex items-center gap-3 font-mono text-sm">
                {f.known ? (
                  <>
                    <span className={cn('font-bold tracking-widest', c.badgeText)}>
                      {f.value.toString(2).padStart(f.highBit - f.lowBit + 1, '0')}
                    </span>
                    <span className="text-zinc-500">= {f.value}</span>
                  </>
                ) : (
                  <span className="text-zinc-600 italic text-xs">not yet determined</span>
                )}
              </div>
            </div>
          )
        })()}
      </div>

      {/* ── Bottom: Flags + Info side by side ─────────────────────────────── */}
      <div className="flex-1 min-h-0 flex overflow-hidden">

        {/* Left: Flags & Operands */}
        <div className="flex-1 min-w-0 overflow-y-auto scrollbar-thin border-r border-zinc-800/60">
          <div className="px-4 py-3">
            {result.flags.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 py-12 text-zinc-700">
                <span className="text-xs font-mono">no flags</span>
              </div>
            ) : (
              <>
                <div className="text-[10px] uppercase tracking-widest text-zinc-700 font-semibold mb-2 px-3">
                  Flags &amp; operands
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4">
                  {result.flags.map((flag, i) => (
                    <FlagRow
                      key={i}
                      flag={flag}
                      field={fieldByShortName.get(flag.name)}
                      result={result}
                      onChange={setInput}
                    />
                  ))}
                </div>
              </>
            )}

            {/* Opcode reference table */}
            <div className="mt-4 pt-3 border-t border-zinc-800/40">
              <div className="text-[10px] uppercase tracking-widest text-zinc-700 font-semibold mb-2 px-3">
                Data Processing Opcodes
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-0.5 px-3 font-mono text-[11px]">
                {([
                  ['0000', 'AND', 'Rd = Rn AND Op2'],
                  ['0001', 'EOR', 'Rd = Rn XOR Op2'],
                  ['0010', 'SUB', 'Rd = Rn − Op2'],
                  ['0011', 'RSB', 'Rd = Op2 − Rn'],
                  ['0100', 'ADD', 'Rd = Rn + Op2'],
                  ['0101', 'ADC', 'Rd = Rn + Op2 + C'],
                  ['0110', 'SBC', 'Rd = Rn − Op2 − !C'],
                  ['1010', 'CMP', 'flags(Rn − Op2)'],
                  ['1100', 'ORR', 'Rd = Rn OR Op2'],
                  ['1101', 'MOV', 'Rd = Op2'],
                  ['00',   'LSL', 'shift type [6:5]'],
                  ['10',   'ASR', 'shift type [6:5]'],
                  ['01',   'LSR', 'shift type [6:5]'],
                ] as const).map(([code, name, desc]) => (
                  <div key={name} className="flex items-center gap-1.5 py-0.5">
                    <span className="text-orange-400/80 w-10 shrink-0">{code}</span>
                    <span className="text-zinc-200 w-8 shrink-0">{name}</span>
                    <span className="text-zinc-600 truncate">{desc}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Right: Info / encoding guide */}
        <div className="w-[420px] shrink-0 overflow-y-auto scrollbar-thin">
          <div className="px-5 py-3 space-y-4 text-[13px] text-zinc-400 leading-relaxed">
            <div className="text-[10px] uppercase tracking-widest text-zinc-700 font-semibold">
              Encoding guide
            </div>

            {/* 32-bit layout */}
            <div>
              <h3 className="text-zinc-200 font-semibold text-sm mb-1">Data Processing layout</h3>
              <div className="font-mono text-[11px] bg-zinc-900/60 rounded-lg border border-zinc-800/60 px-3 py-2 text-zinc-500 leading-relaxed">
                <span className="text-rose-400">cond</span>{' '}
                <span className="text-zinc-600">00</span>{' '}
                <span className="text-amber-400">I</span>{' '}
                <span className="text-orange-400">opcode</span>{' '}
                <span className="text-yellow-400">S</span>{' '}
                <span className="text-emerald-400">Rn</span>{' '}
                <span className="text-sky-400">Rd</span>{' '}
                <span className="text-violet-400">operand2</span>
                <div className="text-zinc-700 mt-1">
                  31:28 · 27:26 · 25 · 24:21 · 20 · 19:16 · 15:12 · 11:0
                </div>
              </div>
            </div>

            {/* Cond */}
            <div>
              <h3 className="text-zinc-200 font-semibold text-sm mb-1">
                <span className="text-rose-400 font-mono">cond</span> — condition code <span className="text-zinc-600 font-mono text-xs">[31:28]</span>
              </h3>
              <p>
                Every ARM instruction is conditionally executed.
                Most instructions use <code className="text-rose-300 bg-rose-950/30 px-1 rounded text-xs">1110</code> (AL — <em>always</em>),
                making them unconditional.
                Adding a condition suffix like <code className="text-zinc-200 text-xs">EQ</code> changes this
                to <code className="text-rose-300 bg-rose-950/30 px-1 rounded text-xs">0000</code>,
                so the instruction only runs when the Z flag is set (previous result was zero).
              </p>
            </div>

            {/* I flag */}
            <div>
              <h3 className="text-zinc-200 font-semibold text-sm mb-1">
                <span className="text-amber-400 font-mono">I</span> — immediate flag <span className="text-zinc-600 font-mono text-xs">[25]</span>
              </h3>
              <p>
                Bit 25 selects how <span className="text-violet-300">operand2</span> is interpreted:
              </p>
              <ul className="mt-1 space-y-1 pl-4 list-disc marker:text-zinc-700">
                <li>
                  <code className="text-amber-300 text-xs">I=1</code> — <strong className="text-zinc-200">immediate</strong>:
                  bits [11:8] are a 4-bit rotation, bits [7:0] are an 8-bit constant.
                  The CPU rotates the 8-bit value right by <em>2 × rotation</em>.
                  This limits which constants can be encoded in one instruction.
                </li>
                <li>
                  <code className="text-amber-300 text-xs">I=0</code> — <strong className="text-zinc-200">register</strong>:
                  bits [3:0] pick a register <span className="text-teal-300">Rm</span>,
                  and bits [11:4] describe an optional barrel-shifter operation on that register.
                </li>
              </ul>
            </div>

            {/* S flag */}
            <div>
              <h3 className="text-zinc-200 font-semibold text-sm mb-1">
                <span className="text-yellow-400 font-mono">S</span> — set flags <span className="text-zinc-600 font-mono text-xs">[20]</span>
              </h3>
              <p>
                When <code className="text-yellow-300 text-xs">S=1</code>,
                the result updates the <strong className="text-zinc-200">CPSR</strong> condition flags (N, Z, C, V).
                Compare instructions (<code className="text-zinc-200 text-xs">CMP</code>,{' '}
                <code className="text-zinc-200 text-xs">CMN</code>,{' '}
                <code className="text-zinc-200 text-xs">TST</code>,{' '}
                <code className="text-zinc-200 text-xs">TEQ</code>) always have S=1.
                Appending <code className="text-zinc-200 text-xs">S</code> to arithmetic mnemonics
                (e.g. <code className="text-zinc-200 text-xs">ADDS</code>) sets this bit.
              </p>
            </div>

            {/* Barrel shifter */}
            <div>
              <h3 className="text-zinc-200 font-semibold text-sm mb-1">Barrel shifter <span className="text-zinc-600 font-mono text-xs">[11:0] when I=0</span></h3>
              <p>
                When the second operand is a register, the barrel shifter can
                transform it before the ALU sees it — for free, in a single cycle:
              </p>
              <div className="font-mono text-[11px] bg-zinc-900/60 rounded-lg border border-zinc-800/60 px-3 py-2 mt-1 space-y-0.5">
                <div><span className="text-blue-300">LSL #n</span> <span className="text-zinc-600">— logical shift left by n</span></div>
                <div><span className="text-blue-300">LSR #n</span> <span className="text-zinc-600">— logical shift right</span></div>
                <div><span className="text-blue-300">ASR #n</span> <span className="text-zinc-600">— arithmetic shift right (preserves sign)</span></div>
                <div><span className="text-blue-300">ROR #n</span> <span className="text-zinc-600">— rotate right</span></div>
              </div>
              <p className="mt-1.5">
                Example: <code className="text-zinc-200 text-xs">ADD R0, R1, R2, LSL #2</code> computes
                R0 = R1 + (R2 × 4) in one instruction.
              </p>
            </div>

            {/* Branch */}
            <div>
              <h3 className="text-zinc-200 font-semibold text-sm mb-1">Branch encoding</h3>
              <div className="font-mono text-[11px] bg-zinc-900/60 rounded-lg border border-zinc-800/60 px-3 py-2 text-zinc-500 leading-relaxed">
                <span className="text-rose-400">cond</span>{' '}
                <span className="text-zinc-600">101</span>{' '}
                <span className="text-lime-400">L</span>{' '}
                <span className="text-green-400">offset (24 bits)</span>
                <div className="text-zinc-700 mt-1">
                  31:28 · 27:25 · 24 · 23:0
                </div>
              </div>
              <p className="mt-1.5">
                Branches use a completely different format — bits [27:25] are <code className="text-zinc-500 text-xs">101</code>.
                The <span className="text-lime-300">L</span> bit distinguishes{' '}
                <code className="text-zinc-200 text-xs">B</code> (L=0) from{' '}
                <code className="text-zinc-200 text-xs">BL</code> (L=1, saves return address in LR).
                The 24-bit offset is sign-extended, shifted left 2, and added to PC+8.
              </p>
            </div>

            {/* Quick examples */}
            <div>
              <h3 className="text-zinc-200 font-semibold text-sm mb-1">Quick reference</h3>
              <div className="font-mono text-[11px] bg-zinc-900/60 rounded-lg border border-zinc-800/60 px-3 py-2 space-y-1">
                <div className="flex justify-between">
                  <span className="text-zinc-300">MOV R0, #42</span>
                  <span className="text-zinc-600">Rd = imm</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-300">ADD R0, R1, R2</span>
                  <span className="text-zinc-600">Rd = Rn + Rm</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-300">RSB R0, R1, #0</span>
                  <span className="text-zinc-600">Rd = 0 − Rn (negate)</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-300">CMP R0, #0</span>
                  <span className="text-zinc-600">set flags for Rn − imm</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-300">BEQ #+8</span>
                  <span className="text-zinc-600">branch if Z=1</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-300">BL #+64</span>
                  <span className="text-zinc-600">branch & link (call)</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Legend footer ────────────────────────────────────────────────── */}
      <footer className="shrink-0 border-t border-zinc-800/60 px-6 py-1.5 flex items-center flex-wrap gap-x-3 gap-y-1 bg-zinc-900/40">
        {(['cond','I','opcode','S','Rn','Rd','op2-rot','op2-imm','op2-shift-amt','op2-shift-type','op2-rm','L','offset','reglist','fixed'] as FieldColor[]).map(key => {
          const c = getColor(key)
          return (
            <span key={key} className="flex items-center gap-1">
              <span className={cn('inline-block w-2 h-2 rounded-sm border', c.box, c.border)} />
              <span className={cn('text-[9px] font-mono', c.label)}>{key}</span>
            </span>
          )
        })}
      </footer>
    </div>
  )
}
