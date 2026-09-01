import { app } from 'electron'
import { autoUpdater } from 'electron-updater'

const GITHUB_OWNER = 'ILoveBingLu'
const GITHUB_REPO = 'CipherTalk'
const GITHUB_FORCE_UPDATE_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest/download/force-update.json`
const GITHUB_MAC_UPDATE_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest/download/latest-mac.yml`
const R2_UPDATE_BASE_URL = 'https://miyuapp.aiqji.com'

export type ForceUpdateReason = 'minimum-version' | 'blocked-version'
export type AppUpdateSource = 'r2' | 'github' | 'custom' | 'none'
export type UpdateDownloadPhase = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'failed'
export type UpdateDownloadStrategy = 'unknown' | 'differential' | 'full'

export interface ForceUpdateManifest {
  schemaVersion: number
  latestVersion?: string
  minimumSupportedVersion?: string
  blockedVersions?: string[]
  title?: string
  message?: string
  releaseNotes?: string
  publishedAt?: string
}

export interface AppUpdateInfo {
  hasUpdate: boolean
  forceUpdate: boolean
  currentVersion: string
  version?: string
  releaseNotes?: string
  title?: string
  message?: string
  minimumSupportedVersion?: string
  reason?: ForceUpdateReason
  checkedAt: number
  updateSource: AppUpdateSource
  policySource: AppUpdateSource
  downloadUrl?: string
  sha512?: string
  fileSize?: number
  diagnostics?: UpdateDiagnostics
}

export interface UpdateDiagnostics {
  phase: UpdateDownloadPhase
  strategy: UpdateDownloadStrategy
  fallbackToFull: boolean
  lastError?: string
  lastEvent?: string
  progressPercent?: number
  downloadedBytes?: number
  totalBytes?: number
  targetVersion?: string
  lastUpdatedAt: number
}

type ManifestLookupResult = {
  manifest: ForceUpdateManifest | null
  source: AppUpdateSource
}

type UpdateFeedSource = 'r2' | 'github'

type UpdateLookupResult = {
  latestVersion?: string
  releaseNotes: string
  hasUpdate: boolean
  source: AppUpdateSource
  downloadUrl?: string
  sha512?: string
  fileSize?: number
}

type MacUpdateManifest = {
  version: string
  artifactName: string
  sha512: string
  size?: number
}

function isNewerVersion(version1: string, version2: string): boolean {
  const v1Parts = version1.split('.').map(Number)
  const v2Parts = version2.split('.').map(Number)
  const maxLength = Math.max(v1Parts.length, v2Parts.length)
  while (v1Parts.length < maxLength) v1Parts.push(0)
  while (v2Parts.length < maxLength) v2Parts.push(0)

  for (let i = 0; i < maxLength; i++) {
    if (v1Parts[i] > v2Parts[i]) return true
    if (v1Parts[i] < v2Parts[i]) return false
  }

  return false
}

function isVersionEqual(version1: string, version2: string): boolean {
  return !isNewerVersion(version1, version2) && !isNewerVersion(version2, version1)
}

function normalizeReleaseNotes(value: unknown): string {
  if (!value) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === 'string') return item
      if (item && typeof item === 'object' && 'note' in item) {
        return String((item as { note?: unknown }).note || '')
      }
      return String(item)
    }).filter(Boolean).join('\n\n')
  }
  if (value && typeof value === 'object' && 'note' in value) {
    return String((value as { note?: unknown }).note || '')
  }
  return String(value)
}

async function fetchManifestFromUrl(url: string): Promise<ForceUpdateManifest | null> {
  try {
    const response = await fetch(`${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`, {
      cache: 'no-store',
      headers: {
        Accept: 'application/json'
      }
    })
    if (!response.ok) return null

    const data = await response.json() as ForceUpdateManifest
    if (!data || typeof data !== 'object') return null
    if (Number(data.schemaVersion || 0) < 1) return null
    return data
  } catch (error) {
    console.warn('[AppUpdate] 获取策略文件失败:', url, error)
    return null
  }
}

async function resolveForceUpdateManifest(): Promise<ManifestLookupResult> {
  // 强制更新已停用：不再从 R2 / GitHub 拉取 force-update.json，客户端永不强制升级
  return { manifest: null, source: 'none' }
}

function stripYamlScalar(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function parseMacUpdateManifest(content: string): MacUpdateManifest | null {
  const version = content.match(/^version:\s*(.+)$/m)?.[1]
  const artifactName = content.match(/^\s*-\s+url:\s*(.+)$/m)?.[1]
  const sha512 = content.match(/^\s+sha512:\s*(.+)$/m)?.[1]
  const sizeValue = content.match(/^\s+size:\s*(\d+)$/m)?.[1]

  if (!version || !artifactName || !sha512) return null

  const parsed = {
    version: stripYamlScalar(version),
    artifactName: stripYamlScalar(artifactName),
    sha512: stripYamlScalar(sha512),
    size: sizeValue ? Number(sizeValue) : undefined
  }

  if (!parsed.artifactName.toLowerCase().endsWith('.dmg')) return null
  return parsed
}

function configureUpdaterFeed(source: UpdateFeedSource): void {
  if (source === 'r2') {
    autoUpdater.setFeedURL({
      provider: 'generic',
      url: R2_UPDATE_BASE_URL
    })
    return
  }

  autoUpdater.setFeedURL({
    provider: 'github',
    owner: GITHUB_OWNER,
    repo: GITHUB_REPO
  })
}

class AppUpdateService {
  private lastInfo: AppUpdateInfo | null = null
  private diagnostics: UpdateDiagnostics = {
    phase: 'idle',
    strategy: 'unknown',
    fallbackToFull: false,
    lastUpdatedAt: Date.now()
  }

  getCachedUpdateInfo(): AppUpdateInfo | null {
    return this.lastInfo
  }

  getR2UpdateBaseUrl(): string {
    return R2_UPDATE_BASE_URL
  }

  getGithubRepository(): { owner: string; repo: string } {
    return {
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO
    }
  }

  private buildInfo(payload: Partial<AppUpdateInfo>): AppUpdateInfo {
    return {
      hasUpdate: false,
      forceUpdate: false,
      currentVersion: app.getVersion(),
      checkedAt: Date.now(),
      updateSource: 'none',
      policySource: 'none',
      diagnostics: this.diagnostics,
      ...payload
    }
  }

  resetDiagnostics(targetVersion?: string): void {
    this.diagnostics = {
      phase: 'idle',
      strategy: 'unknown',
      fallbackToFull: false,
      targetVersion,
      lastUpdatedAt: Date.now()
    }
  }

  updateDiagnostics(patch: Partial<UpdateDiagnostics>): void {
    this.diagnostics = {
      ...this.diagnostics,
      ...patch,
      lastUpdatedAt: Date.now()
    }

    if (this.lastInfo) {
      this.lastInfo = {
        ...this.lastInfo,
        diagnostics: this.diagnostics
      }
    }
  }

  noteUpdaterMessage(message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    const normalized = message.toLowerCase()
    const patch: Partial<UpdateDiagnostics> = { lastEvent: message }

    if (normalized.includes('differential')) {
      patch.strategy = 'differential'
    }

    if (
      normalized.includes('fallback to full') ||
      normalized.includes('fallback to full download') ||
      normalized.includes('cannot download differentially') ||
      normalized.includes('cannot download differentially, fallback to full download')
    ) {
      patch.strategy = 'full'
      patch.fallbackToFull = true
      patch.lastEvent = '差分更新失败，已回退到全量下载'
      if (this.diagnostics.phase === 'idle') {
        patch.phase = 'downloading'
      }
    }

    if (level === 'error') {
      patch.lastError = message
      if (this.diagnostics.phase !== 'downloaded' && this.diagnostics.phase !== 'installing') {
        patch.phase = 'failed'
      }
    }

    this.updateDiagnostics(patch)
  }

  private async checkUpdaterSource(source: UpdateFeedSource, currentVersion: string): Promise<UpdateLookupResult | null> {
    if (process.platform === 'darwin') {
      return this.checkMacUpdaterSource(source, currentVersion)
    }

    configureUpdaterFeed(source)
    const result = await autoUpdater.checkForUpdates()
    if (!result?.updateInfo?.version) {
      return null
    }

    const latestVersion = result.updateInfo.version
    const hasUpdate = isNewerVersion(latestVersion, currentVersion)
    return {
      latestVersion,
      releaseNotes: normalizeReleaseNotes(result.updateInfo.releaseNotes),
      hasUpdate,
      source: hasUpdate ? source : 'none'
    }
  }

  private async checkMacUpdaterSource(source: UpdateFeedSource, currentVersion: string): Promise<UpdateLookupResult> {
    const manifestUrl = source === 'r2'
      ? `${R2_UPDATE_BASE_URL.replace(/\/+$/, '')}/latest-mac.yml`
      : GITHUB_MAC_UPDATE_URL
    const response = await fetch(`${manifestUrl}?t=${Date.now()}`, {
      cache: 'no-store',
      headers: { Accept: 'text/yaml, text/plain' }
    })

    if (!response.ok) {
      throw new Error(`获取 macOS 更新清单失败: HTTP ${response.status}`)
    }

    const manifest = parseMacUpdateManifest(await response.text())
    if (!manifest) {
      throw new Error('macOS 更新清单无效或未指向 DMG')
    }

    const downloadUrl = new URL(manifest.artifactName, manifestUrl).toString()
    if (!downloadUrl.startsWith('https://')) {
      throw new Error('macOS 更新包地址必须使用 HTTPS')
    }

    const hasUpdate = isNewerVersion(manifest.version, currentVersion)
    return {
      latestVersion: manifest.version,
      releaseNotes: '',
      hasUpdate,
      source: hasUpdate ? source : 'none',
      downloadUrl: hasUpdate ? downloadUrl : undefined,
      sha512: hasUpdate ? manifest.sha512 : undefined,
      fileSize: hasUpdate ? manifest.size : undefined
    }
  }

  async checkForUpdates(): Promise<AppUpdateInfo> {
    const currentVersion = app.getVersion()
    let latestVersion: string | undefined
    let releaseNotes = ''
    let hasUpdate = false
    let updateSource: AppUpdateSource = 'none'
    let downloadUrl: string | undefined
    let sha512: string | undefined
    let fileSize: number | undefined

    this.resetDiagnostics()
    this.updateDiagnostics({
      phase: 'checking',
      lastEvent: '开始检查更新'
    })

    try {
      let result: UpdateLookupResult | null = null

      try {
        result = await this.checkUpdaterSource('r2', currentVersion)
      } catch (r2Error) {
        console.warn('[AppUpdate] 检查 R2 更新失败，回退 GitHub:', r2Error)
        this.updateDiagnostics({
          lastError: String(r2Error),
          lastEvent: 'R2 更新源检查失败，回退 GitHub'
        })
      }

      if (!result) {
        result = await this.checkUpdaterSource('github', currentVersion)
      }

      if (result?.latestVersion) {
        latestVersion = result.latestVersion
        releaseNotes = result.releaseNotes
        hasUpdate = result.hasUpdate
        updateSource = result.source
        downloadUrl = result.downloadUrl
        sha512 = result.sha512
        fileSize = result.fileSize
        this.updateDiagnostics({
          phase: hasUpdate ? 'available' : 'idle',
          targetVersion: latestVersion,
          lastEvent: hasUpdate ? `检测到新版本 ${latestVersion}` : '当前已是最新版本'
        })
      } else {
        this.updateDiagnostics({
          phase: 'idle',
          lastEvent: '未获取到远端版本信息'
        })
      }
    } catch (error) {
      this.updateDiagnostics({
        phase: 'failed',
        lastError: String(error),
        lastEvent: '检查更新失败'
      })
      console.error('[AppUpdate] 检查 GitHub 更新失败:', error)
    }

    const { manifest, source: policySource } = await resolveForceUpdateManifest()
    let forceUpdate = false
    let reason: ForceUpdateReason | undefined

    if (manifest?.minimumSupportedVersion && isNewerVersion(manifest.minimumSupportedVersion, currentVersion)) {
      forceUpdate = true
      reason = 'minimum-version'
    } else if (manifest?.blockedVersions?.some((version) => isVersionEqual(currentVersion, version))) {
      forceUpdate = true
      reason = 'blocked-version'
    }

    const finalVersion = latestVersion || manifest?.latestVersion
    const finalReleaseNotes = releaseNotes || manifest?.releaseNotes || ''

    const info = this.buildInfo({
      hasUpdate: hasUpdate || forceUpdate,
      forceUpdate,
      currentVersion,
      version: finalVersion,
      releaseNotes: finalReleaseNotes,
      title: manifest?.title || (forceUpdate ? '必须更新到最新版本' : undefined),
      message: manifest?.message,
      minimumSupportedVersion: manifest?.minimumSupportedVersion,
      reason,
      updateSource,
      policySource,
      downloadUrl,
      sha512,
      fileSize
    })

    this.lastInfo = info
    return info
  }

  /**
   * 开发模式专用：构造一个模拟的更新信息，用于在 dev 环境下测试更新提示 UI。
   * 不会真实检查远端版本，也不会触发下载/安装。
   */
  createSimulatedUpdateInfo(): AppUpdateInfo {
    this.resetDiagnostics('6.0.4')
    this.updateDiagnostics({
      phase: 'available',
      lastEvent: '检测到新版本 6.0.4（开发模式模拟）'
    })
    const info = this.buildInfo({
      hasUpdate: true,
      version: '6.0.4',
      releaseNotes: '开发模式模拟更新，仅用于测试更新提示 UI。',
      updateSource: 'r2',
      policySource: 'none'
    })
    this.lastInfo = info
    return info
  }
}

export const appUpdateService = new AppUpdateService()
