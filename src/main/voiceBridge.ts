// 本机语音桥接：调用 Windows 系统语音引擎（System.Speech / SAPI）播报中文整组总结。
// 完全离线，不依赖在线 TTS；缺少中文语音时返回明确状态，文字反馈仍完整可用。
import { ipcMain } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { IPC } from '../shared/ipc'
import type { VoiceAvailability } from '../shared/types'

let currentSpeakProcess: ChildProcess | null = null

const PS = 'powershell.exe'
const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command']

const LIST_VOICES_SCRIPT = [
  'Add-Type -AssemblyName System.Speech',
  '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
  '$s.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name + "`t" + $_.VoiceInfo.Culture.Name + "`t" + $_.Enabled }'
].join('; ')

const SPEAK_SCRIPT = [
  'Add-Type -AssemblyName System.Speech',
  '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
  '$zh = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like "zh*" -and $_.Enabled } | Select-Object -First 1',
  'if ($zh) { $s.SelectVoice($zh.VoiceInfo.Name) }',
  '$s.Speak($env:DLSAY_TEXT)'
].join('; ')

interface VoiceEntry {
  name: string
  culture: string
  enabled: boolean
}

function isChinese(culture: string): boolean {
  return culture.toLowerCase().startsWith('zh')
}

async function listVoices(): Promise<VoiceEntry[]> {
  return new Promise((resolve) => {
    const child = spawn(PS, [...PS_ARGS, LIST_VOICES_SCRIPT])
    let stdout = ''
    let settled = false
    const done = (entries: VoiceEntry[]): void => {
      if (settled) return
      settled = true
      resolve(entries)
    }
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.on('error', () => done([]))
    child.on('close', () => {
      const entries = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [name = '', culture = '', enabled = ''] = line.split('\t')
          return { name, culture, enabled: enabled.toLowerCase() === 'true' }
        })
        .filter((e) => e.name.length > 0)
      done(entries)
    })
  })
}

export function registerVoiceBridge(): void {
  ipcMain.handle(IPC.voiceCheckAvailability, async (): Promise<VoiceAvailability> => {
    if (process.platform !== 'win32') {
      return { available: false, voices: [], error: 'NO_CHINESE_VOICE' }
    }
    try {
      const voices = await listVoices()
      const chinese = voices.filter((v) => v.enabled && isChinese(v.culture)).map((v) => v.name)
      return {
        available: chinese.length > 0,
        voices: chinese,
        error: chinese.length > 0 ? undefined : 'NO_CHINESE_VOICE'
      }
    } catch {
      return { available: false, voices: [], error: 'ENGINE_INIT_FAILED' }
    }
  })

  ipcMain.handle(
    IPC.voiceSpeak,
    async (_event, text: string): Promise<{ started: boolean; error?: string }> => {
      if (process.platform !== 'win32') {
        return { started: false, error: 'NO_CHINESE_VOICE' }
      }
      const content = typeof text === 'string' ? text.trim() : ''
      if (!content) return { started: false, error: 'ENGINE_INIT_FAILED' }
      if (currentSpeakProcess) {
        currentSpeakProcess.kill()
        currentSpeakProcess = null
      }
      try {
        const child = spawn(PS, [...PS_ARGS, SPEAK_SCRIPT], {
          env: { ...process.env, DLSAY_TEXT: content }
        })
        currentSpeakProcess = child
        const started = await new Promise<boolean>((resolve) => {
          let resolved = false
          child.on('spawn', () => {
            if (!resolved) {
              resolved = true
              resolve(true)
            }
          })
          child.on('error', () => {
            if (!resolved) {
              resolved = true
              resolve(false)
            }
          })
        })
        child.on('close', () => {
          if (currentSpeakProcess === child) currentSpeakProcess = null
        })
        return started ? { started: true } : { started: false, error: 'ENGINE_INIT_FAILED' }
      } catch {
        return { started: false, error: 'ENGINE_INIT_FAILED' }
      }
    }
  )

  ipcMain.handle(IPC.voiceStop, async (): Promise<void> => {
    if (currentSpeakProcess) {
      currentSpeakProcess.kill()
      currentSpeakProcess = null
    }
  })
}
