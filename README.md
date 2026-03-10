# armv7.nithitsuki.com

An interactive ARMv7 instruction encoder/visualiser — type an ARM assembly instruction and watch its 32-bit binary encoding build up in real time, with colour-coded bit fields, dropdowns to tweak individual flags, and an integrated encoding guide.

**Built the night before my 23CSE213 Computer Organization and Architecture midsem exam.**

This was agentic-engineered in about an hour using Anthropic's Claude Opus 4.6 and Sonnet 4.6 via GitHub Copilot, by [nithitsuki](https://github.com/nithitsuki).

## Features

- **Live encoding** — progressive/partial assembly as you type, bit-by-bit
- **Colour-coded bit fields** — condition, opcode, registers, flags, operand2 each get distinct colours
- **Interactive dropdowns** — click any flag or register field to change it and see the encoding update
- **Encoding guide** — built-in reference for condition codes, I/S flags, barrel shifter, branch format
- **Opcode table** — quick-reference for common data processing opcodes
- **Supports**: data processing (MOV, ADD, SUB, CMP, etc.), branches (B, BL, BX), load/store (LDR, STR with all addressing modes), multiply (MUL, MLA), block transfers (PUSH, POP, LDM, STM), barrel shifter ops (LSL, LSR, ASR, ROR)

## Stack

Vite + React 19 + TypeScript · Tailwind CSS v4 + shadcn · Bun
