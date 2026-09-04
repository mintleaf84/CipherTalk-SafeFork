import { basename, delimiter, dirname, join } from 'path'
import { existsSync, readdirSync, statSync } from 'fs'
import { decodeMessageContent, getRowField, coerceRowNumber, quoteInt64ServerIds } from './chat/rowDecoders'
import { formatWcdbOpenFailure } from './wcdbOpenFailure'

// 消息表 local_type 列在不同微信版本下的可能列名
const MSG_TYPE_COLUMNS = [
  'local_type', 'localType', 'type', 'Type',
  'msg_type', 'msgType', 'MsgType',
  'message_type', 'messageType', 'WCDB_CT_local_type'
]

// server_id 列的可能列名；64 位值超出 JS Number 安全范围，需以字符串透传
const SERVER_ID_COLUMNS = ['server_id', 'msg_svr_id', 'msgSvrId', 'MsgSvrID']

/**
 * WcdbCore —— 直连微信加密数据库的底层封装。
 * - 不依赖 Electron `app`，可在 utilityProcess 中实例化
 * - 所有资源路径通过 setPaths() 注入
 * - C 符号按需探测，未绑定的新符号不会导致初始化失败（特性可降级）
 */
export class WcdbCore {
  private lib: any = null
  private koffi: any = null
  private initialized = false
  private handle: number | null = null
  private currentPath: string | null = null
  private currentKey: string | null = null
  private currentWxid: string | null = null
  private currentDbStoragePath: string | null = null
  private resourcesPath: string | null = null
  private userDataPath: string | null = null
  private appVersion = ''

  // 已暴露的 C 符号
  private wcdbInit: any = null
  private wcdbShutdown: any = null
  private wcdbOpenAccount: any = null
  private wcdbCloseAccount: any = null
  private wcdbFreeString: any = null
  private wcdbGetLogs: any = null
  private wcdbGetSnsTimeline: any = null
  private wcdbExecQuery: any = null

  // 预留的 C 符号（native 未实现则置 null，特性降级）
  private wcdbExecQueryWithParams: any = null
  private wcdbExportMessageChunk: any = null
  private wcdbGetMessages: any = null
  private wcdbStartMonitorPipe: any = null
  private wcdbStopMonitorPipe: any = null
  private wcdbGetMonitorPipeName: any = null
  private wcdbSetMyWxid: any = null
  private wcdbSetAppVersion: any = null
  private wcdbSetClientInfo: any = null
  private wcdbCheckLicense: any = null

  // 管道监控状态
  private monitorPipeClient: any = null
  private monitorCallback: ((type: string, json: string) => void) | null = null
  private monitorReconnectTimer: any = null
  private monitorPipePath: string = ''

  setPaths(resourcesPath: string, userDataPath: string, appVersion = ''): void {
    this.resourcesPath = resourcesPath
    this.userDataPath = userDataPath
    this.appVersion = appVersion
  }

  getUserDataPath(): string | null { return this.userDataPath }

  private getLibraryPath(): string {
    const baseDir = this.resourcesPath || join(process.cwd(), 'resources')
    if (process.platform === 'darwin') return join(baseDir, 'macos', 'libwcdb_api.dylib')
    return join(baseDir, 'wcdb_api.dll')
  }

  private getWindowsCoreLibraryPath(): string {
    const baseDir = this.resourcesPath || join(process.cwd(), 'resources')
    return join(baseDir, 'WCDB.dll')
  }

  private prepareWindowsDllSearchPath(libraryPath: string): { success: boolean; error?: string } {
    if (process.platform === 'darwin') {
      const dylibDir = dirname(libraryPath)
      const currentDyld = process.env.DYLD_LIBRARY_PATH || ''
      if (!currentDyld.includes(dylibDir)) {
        process.env.DYLD_LIBRARY_PATH = dylibDir + (currentDyld ? ':' + currentDyld : '')
      }
      return { success: true }
    }

    if (process.platform !== 'win32') return { success: true }

    const wcdbCorePath = this.getWindowsCoreLibraryPath()
    if (!existsSync(wcdbCorePath)) {
      return { success: false, error: `WCDB 依赖库不存在: ${wcdbCorePath}` }
    }

    const dllDir = dirname(libraryPath)
    const pathParts = (process.env.PATH || '').split(delimiter).filter(Boolean)
    const hasDllDir = pathParts.some(item => item.toLowerCase() === dllDir.toLowerCase())
    if (!hasDllDir) {
      process.env.PATH = [dllDir, ...pathParts].join(delimiter)
    }

    return { success: true }
  }

  async initialize(): Promise<{ success: boolean; error?: string }> {
    if (this.initialized) return { success: true }

    try {
      this.koffi = require('koffi')
      const libraryPath = this.getLibraryPath()
      if (!existsSync(libraryPath)) {
        return { success: false, error: `WCDB 原生库不存在: ${libraryPath}` }
      }

      const dllSearchRes = this.prepareWindowsDllSearchPath(libraryPath)
      if (!dllSearchRes.success) return dllSearchRes

      this.lib = this.koffi.load(libraryPath)

      // 绑定已确定暴露的符号
      this.wcdbInit = this.lib.func('int32 wcdb_init()')
      this.wcdbShutdown = this.lib.func('int32 wcdb_shutdown()')
      this.wcdbOpenAccount = this.lib.func('int32 wcdb_open_account(const char* path, const char* key, _Out_ int64* handle)')
      this.wcdbCloseAccount = this.lib.func('int32 wcdb_close_account(int64 handle)')
      this.wcdbFreeString = this.lib.func('void wcdb_free_string(void* ptr)')
      this.wcdbGetLogs = this.lib.func('int32 wcdb_get_logs(_Out_ void** outJson)')
      this.wcdbGetSnsTimeline = this.lib.func('int32 wcdb_get_sns_timeline(int64 handle, int32 limit, int32 offset, const char* username, const char* keyword, int32 startTime, int32 endTime, _Out_ void** outJson)')
      this.wcdbExecQuery = this.lib.func('int32 wcdb_exec_query(int64 handle, const char* kind, const char* path, const char* sql, _Out_ void** outJson)')

      // 预留符号：native 若未实现则保持 null，特性降级
      const tryBind = (decl: string): any => {
        try { return this.lib.func(decl) } catch { return null }
      }
      this.wcdbExecQueryWithParams = tryBind('int32 wcdb_exec_query_with_params(int64 handle, const char* kind, const char* path, const char* sql, const char* argsJson, _Out_ void** outJson)')
      this.wcdbExportMessageChunk = tryBind('int32 wcdb_export_message_chunk(int64 handle, const char* kind, const char* path, const char* tableName, int64 afterRid, int32 maxRows, int32 startTime, int32 endTime, const char* extraColsJson, _Out_ void** outJson)')
      this.wcdbGetMessages = tryBind('int32 wcdb_get_messages(int64 handle, const char* username, int32 limit, int32 offset, _Out_ void** outJson)')
      this.wcdbStartMonitorPipe = tryBind('int32 wcdb_start_monitor_pipe()')
      this.wcdbStopMonitorPipe = tryBind('int32 wcdb_stop_monitor_pipe()')
      this.wcdbGetMonitorPipeName = tryBind('int32 wcdb_get_monitor_pipe_name(_Out_ void** outName)')
      this.wcdbSetMyWxid = tryBind('int32 wcdb_set_my_wxid(int64 handle, const char* wxid)')
      this.wcdbSetClientInfo = tryBind('int32 wcdb_set_client_info(const char* applicationId, const char* clientType, const char* appVersion)')
      this.wcdbCheckLicense = tryBind('int32 wcdb_check_license()')
      this.wcdbSetAppVersion = tryBind('int32 wcdb_set_app_version(const char* version)')
      // [CTF] Set client info (keep) but skip return check & license validation
      if (this.wcdbSetClientInfo) {
        try { this.wcdbSetClientInfo('ciphertalk', 'desktop', this.appVersion) } catch {}
      } else if (this.wcdbSetAppVersion) {
        try { this.wcdbSetAppVersion(this.appVersion) } catch {}
      }
      // License check bypassed — wcdb_check_license() patched in DLL to return 0
      const initResult = this.wcdbInit()
      if (initResult !== 0) {
        return { success: false, error: this.mapStatusCode(initResult) }
      }

      this.initialized = true
      return { success: true }
    } catch (e: any) {
      return { success: false, error: `WCDB 初始化异常: ${e.message || String(e)}` }
    }
  }

  async checkLicense(): Promise<{ success: boolean; error?: string }> {
    return this.initialize()
  }

  // ============== 路径解析 ==============
  private findSessionDbs(dir: string, depth = 0, results: string[] = []): string[] {
    if (depth > 5) return results
    try {
      const entries = readdirSync(dir)
      for (const entry of entries) {
        if (entry.toLowerCase() === 'session.db') {
          const fullPath = join(dir, entry)
          if (statSync(fullPath).isFile() && !results.includes(fullPath)) {
            results.push(fullPath)
          }
        }
      }
      for (const entry of entries) {
        const fullPath = join(dir, entry)
        try {
          if (statSync(fullPath).isDirectory()) {
            this.findSessionDbs(fullPath, depth + 1, results)
          }
        } catch {
          // ignore
        }
      }
    } catch (e) {
      console.error('查找 session.db 失败:', e)
    }
    return results
  }

  private scoreSessionDbPath(filePath: string): number {
    const normalized = filePath.replace(/\\/g, '/').toLowerCase()
    let score = 0
    if (normalized.endsWith('/session/session.db')) score += 40
    if (normalized.includes('/db_storage/session/')) score += 20
    if (normalized.includes('/db_storage/')) score += 10
    return score
  }

  private getCandidateSessionDbs(dbStoragePath: string): string[] {
    return this.findSessionDbs(dbStoragePath)
      .sort((a, b) => this.scoreSessionDbPath(b) - this.scoreSessionDbPath(a) || a.localeCompare(b))
  }

  private resolveDbStoragePath(dbPath: string, wxid: string): string | null {
    if (!dbPath) return null
    const normalizedDbPath = dbPath.replace(/[\\/]+$/, '')
    if (basename(normalizedDbPath).toLowerCase() === 'db_storage' && existsSync(normalizedDbPath)) return normalizedDbPath
    const direct = join(normalizedDbPath, 'db_storage')
    if (existsSync(direct)) return direct
    if (wxid) {
      const viaWxid = join(normalizedDbPath, wxid, 'db_storage')
      if (existsSync(viaWxid)) return viaWxid
      try {
        const lowerWxid = wxid.toLowerCase()
        for (const entry of readdirSync(normalizedDbPath)) {
          const entryPath = join(normalizedDbPath, entry)
          try { if (!statSync(entryPath).isDirectory()) continue } catch { continue }
          const lowerEntry = entry.toLowerCase()
          if (lowerEntry !== lowerWxid && !lowerEntry.startsWith(`${lowerWxid}_`)) continue
          const candidate = join(entryPath, 'db_storage')
          if (existsSync(candidate)) return candidate
        }
      } catch { /* ignore */ }
    }
    return null
  }

  private tryOpenWithCandidates(sessionDbPaths: string[], hexKey: string): { success: boolean; handle?: number; matchedPath?: string; errors: string[] } {
    const errors: string[] = []
    for (const sessionDbPath of sessionDbPaths) {
      const handleOut = [0]
      const result = this.wcdbOpenAccount(sessionDbPath, hexKey, handleOut)
      if (result === 0 && handleOut[0] > 0) {
        return { success: true, handle: handleOut[0], matchedPath: sessionDbPath, errors }
      }
      errors.push(`${sessionDbPath} => ${this.mapStatusCode(result)}`)
    }
    return { success: false, errors }
  }

  // ============== 连接生命周期 ==============
  async open(dbPath: string, hexKey: string, wxid: string): Promise<boolean> {
    try {
      if (
        this.handle !== null &&
        this.currentPath === dbPath &&
        this.currentKey === hexKey &&
        this.currentWxid === wxid
      ) {
        return true
      }

      const initRes = await this.initialize()
      if (!initRes.success) return false

      if (this.handle !== null) {
        this.close()
        const reinitRes = await this.initialize()
        if (!reinitRes.success) return false
      }

      const dbStoragePath = this.resolveDbStoragePath(dbPath, wxid)
      if (!dbStoragePath) {
        console.error('数据库目录不存在:', dbPath)
        return false
      }

      const sessionDbPaths = this.getCandidateSessionDbs(dbStoragePath)
      if (sessionDbPaths.length === 0) {
        console.error('未找到 session.db 文件:', dbStoragePath)
        return false
      }

      const openResult = this.tryOpenWithCandidates(sessionDbPaths, hexKey)
      if (!openResult.success || !openResult.handle) {
        await this.printLogs()
        return false
      }

      const handle = openResult.handle
      if (handle <= 0) return false

      this.handle = handle
      this.currentPath = dbPath
      this.currentKey = hexKey
      this.currentWxid = wxid
      this.currentDbStoragePath = dbStoragePath
      this.initialized = true

      // 可选：若 native 支持，则绑定当前 wxid
      if (this.wcdbSetMyWxid && wxid) {
        try {
          this.wcdbSetMyWxid(this.handle, wxid)
        } catch (e) {
          console.warn('wcdb_set_my_wxid 调用失败（可忽略）:', e)
        }
      }

      return true
    } catch (e) {
      console.error('打开数据库异常:', e)
      return false
    }
  }

  close(): void {
    if (this.handle !== null && this.wcdbCloseAccount) {
      try { this.wcdbCloseAccount(this.handle) } catch (e) { console.error('关闭 WCDB 句柄失败:', e) }
    }
    if (this.initialized && this.wcdbShutdown) {
      try { this.wcdbShutdown() } catch (e) { console.error('WCDB shutdown 失败:', e) }
    }
    this.handle = null
    this.initialized = false
    this.lib = null
    this.currentPath = null
    this.currentKey = null
    this.currentWxid = null
    this.currentDbStoragePath = null
  }

  shutdown(): void { this.close() }

  isConnected(): boolean { return this.initialized && this.handle !== null }

  async testConnection(dbPath: string, hexKey: string, wxid: string): Promise<{ success: boolean; error?: string; sessionCount?: number }> {
    try {
      if (this.handle !== null && this.currentPath === dbPath && this.currentKey === hexKey && this.currentWxid === wxid) {
        return { success: true, sessionCount: 0 }
      }

      const hadActive = this.handle !== null
      const prevPath = this.currentPath
      const prevKey = this.currentKey
      const prevWxid = this.currentWxid

      const initRes = await this.initialize()
      if (!initRes.success) return { success: false, error: initRes.error || 'WCDB 初始化失败' }

      const dbStoragePath = this.resolveDbStoragePath(dbPath, wxid)
      if (!dbStoragePath) return { success: false, error: `未找到账号目录或 db_storage: ${dbPath}` }

      const sessionDbPaths = this.getCandidateSessionDbs(dbStoragePath)
      if (sessionDbPaths.length === 0) return { success: false, error: `未找到 session.db 文件: ${dbStoragePath}` }

      const openResult = this.tryOpenWithCandidates(sessionDbPaths, hexKey)
      if (!openResult.success || !openResult.handle || !openResult.matchedPath) {
        const logs = await this.printLogs()
        console.error('[wcdbCore] 数据库验证失败', {
          dbStoragePath,
          attempts: openResult.errors,
          nativeLogs: logs,
        })
        return {
          success: false,
          error: formatWcdbOpenFailure(logs, openResult.errors),
        }
      }

      if (openResult.handle <= 0) return { success: false, error: '无效的数据库句柄' }

      try {
        // 先关闭刚打开的测试句柄，再 shutdown。
        // 带着未关闭的数据库句柄做全局 shutdown 会导致 native 崩溃（整个 app 闪退）。
        if (this.wcdbCloseAccount && openResult.handle) {
          try { this.wcdbCloseAccount(openResult.handle) } catch (e) { console.error('关闭测试句柄失败:', e) }
        }
        // 同时关闭可能残留的旧连接句柄
        if (this.wcdbCloseAccount && this.handle !== null) {
          try { this.wcdbCloseAccount(this.handle) } catch (e) { console.error('关闭旧句柄失败:', e) }
        }
        this.wcdbShutdown()
        this.handle = null
        this.currentPath = null
        this.currentKey = null
        this.currentWxid = null
        this.currentDbStoragePath = null
        this.initialized = false
      } catch (e) {
        console.error('关闭测试数据库时出错:', e)
      }

      if (hadActive && prevPath && prevKey && prevWxid) {
        try { await this.open(prevPath, prevKey, prevWxid) } catch { /* ignore restore failure */ }
      }

      return { success: true, sessionCount: 0 }
    } catch (e) {
      console.error('测试连接异常:', e)
      return { success: false, error: String(e) }
    }
  }

  // ============== 查询接口 ==============
  async execQuery(kind: string, path: string, sql: string): Promise<{ success: boolean; rows?: any[]; error?: string }> {
    if (!this.initialized || this.handle === null) {
      return { success: false, error: 'WCDB 未初始化' }
    }
    try {
      const outJson = [null]
      const result = this.wcdbExecQuery(this.handle, kind, path || '', sql, outJson)
      if (result !== 0 || !outJson[0]) {
        return { success: false, error: this.mapStatusCode(result) }
      }
      const jsonStr = this.koffi.decode(outJson[0], 'char', -1)
      this.wcdbFreeString(outJson[0])
      return { success: true, rows: JSON.parse(jsonStr) }
    } catch (e: any) {
      return { success: false, error: e.message || String(e) }
    }
  }

  /**
   * 参数化查询。
   * 参数数组需序列化为 `[{type:'string'|'int'|'double'|'bytes'|'null', value:any}]`。
   * 若 native 未绑定该符号，将抛出明确错误。
   */
  async execQueryWithParams(kind: string, path: string, sql: string, params?: any[]): Promise<{ success: boolean; rows?: any[]; error?: string }> {
    if (!this.initialized || this.handle === null) {
      return { success: false, error: 'WCDB 未初始化' }
    }
    if (!this.wcdbExecQueryWithParams) {
      return { success: false, error: 'native 未支持参数化查询' }
    }
    try {
      const typed = (params || []).map(this.inferParamDescriptor)
      const argsJson = JSON.stringify(typed)
      const outJson = [null]
      const result = this.wcdbExecQueryWithParams(this.handle, kind, path || '', sql, argsJson, outJson)
      if (result !== 0 || !outJson[0]) {
        return { success: false, error: this.mapStatusCode(result) }
      }
      const jsonStr = this.koffi.decode(outJson[0], 'char', -1)
      this.wcdbFreeString(outJson[0])
      return { success: true, rows: JSON.parse(jsonStr) }
    } catch (e: any) {
      return { success: false, error: e.message || String(e) }
    }
  }

  private inferParamDescriptor(value: any): { type: string; value: any } {
    if (value === null || value === undefined) {
      return { type: 'null', value: null }
    }
    if (typeof value === 'object' && value && typeof (value as any).type === 'string' && 'value' in value) {
      return value as { type: string; value: any }
    }
    if (typeof value === 'number') {
      return Number.isInteger(value) ? { type: 'int', value } : { type: 'double', value }
    }
    if (typeof value === 'bigint') {
      return { type: 'int', value: value.toString() }
    }
    if (typeof value === 'boolean') {
      return { type: 'int', value: value ? 1 : 0 }
    }
    if (Buffer.isBuffer(value)) {
      return { type: 'bytes', value: value.toString('base64') }
    }
    if (value instanceof Uint8Array) {
      return { type: 'bytes', value: Buffer.from(value).toString('base64') }
    }
    return { type: 'string', value: String(value) }
  }

  /**
   * 导出专用批量读取：keyset 分批查询、列裁剪、时间下推与内容解码全部在本进程内完成，
   * 每次调用最多返回 maxRows 条紧凑行（content/localType 已解码），
   * 避免把 SELECT m.* 的原始大对象（含 hex/base64 blob）逐批经 IPC 搬回主进程。
   */
  async readMessageChunk(
    kind: string,
    path: string,
    tableName: string,
    opts: { afterRid: number; maxRows?: number; startTime?: number; endTime?: number; extraCols?: string[] }
  ): Promise<{ success: boolean; rows?: any[]; lastRid?: number; done?: boolean; error?: string }> {
    if (!/^[A-Za-z0-9_]+$/.test(tableName)) {
      return { success: false, error: `非法表名: ${tableName}` }
    }

    // 优先走原生 wcdb_export_message_chunk：列裁剪/时间过滤/zstd 解码全在 DLL 内完成，
    // content 直接以解码文本返回，省掉 blob→hex→JSON→parse→fzstd 整条搬运链。
    // 原生失败或未绑定（Mac/旧 DLL）时回退下方 JS 实现。
    if (this.wcdbExportMessageChunk && this.initialized && this.handle !== null) {
      try {
        const outJson = [null]
        const rc = this.wcdbExportMessageChunk(
          this.handle, kind, path || '', tableName,
          typeof opts.afterRid === 'number' ? opts.afterRid : -1,
          Math.max(1, opts.maxRows || 20000),
          typeof opts.startTime === 'number' ? Math.floor(opts.startTime) : 0,
          typeof opts.endTime === 'number' ? Math.floor(opts.endTime) : 0,
          JSON.stringify((opts.extraCols || []).filter(c => /^[A-Za-z0-9_]+$/.test(c))),
          outJson
        )
        if (rc === 0 && outJson[0]) {
          const jsonStr = this.koffi.decode(outJson[0], 'char', -1)
          this.wcdbFreeString(outJson[0])
          const parsed = JSON.parse(quoteInt64ServerIds(jsonStr))
          return { success: true, rows: parsed.rows || [], lastRid: parsed.lastRid, done: !!parsed.done }
        }
      } catch { /* 回退 JS 实现 */ }
    }

    const name2id = await this.execQuery(kind, path, "SELECT name FROM sqlite_master WHERE type='table' AND name='Name2Id'")
    const hasName2Id = !!(name2id.success && name2id.rows && name2id.rows.length > 0)

    // 附加透传列（如 packed_info_data），仅接受合法标识符
    const extraCols = (opts.extraCols || []).filter(c => /^[A-Za-z0-9_]+$/.test(c))
    let pickedExtras = extraCols

    // 列裁剪：只取导出需要的列；PRAGMA 失败时回退 m.*（仍保留就地解码与时间下推的收益）
    let selectCols = 'm.*'
    let hasCreateTime = true
    const pragma = await this.execQuery(kind, path, `PRAGMA table_info(${tableName})`)
    if (pragma.success && pragma.rows && pragma.rows.length > 0) {
      const cols = new Set(pragma.rows.map((r: any) => String(r.name)))
      hasCreateTime = cols.has('create_time')
      const wanted = [
        'local_id', 'localId', ...SERVER_ID_COLUMNS,
        'create_time', 'is_send', 'message_content', 'compress_content'
      ]
      pickedExtras = extraCols.filter(c => cols.has(c))
      const picked = [...new Set([...wanted.filter(c => cols.has(c)), ...MSG_TYPE_COLUMNS.filter(c => cols.has(c)), ...pickedExtras])]
      // server_id 在 SQL 层转 TEXT，避免行 JSON 经 JSON.parse 后 64 位整数丢精度
      if (picked.length > 0) selectCols = picked.map(c => SERVER_ID_COLUMNS.includes(c) ? `CAST(m."${c}" AS TEXT) AS "${c}"` : `m."${c}"`).join(', ')
    }

    let sql: string
    if (hasName2Id) {
      sql = `SELECT ${selectCols}, n.user_name AS sender_username, m.rowid AS __rid FROM ${tableName} m LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid`
    } else {
      sql = `SELECT ${selectCols}, m.rowid AS __rid FROM ${tableName} m`
    }
    let timeCond = ''
    if (hasCreateTime && typeof opts.startTime === 'number' && typeof opts.endTime === 'number') {
      timeCond = ` AND m.create_time >= ${Math.floor(opts.startTime)} AND m.create_time <= ${Math.floor(opts.endTime)}`
    }

    const maxRows = Math.max(1, opts.maxRows || 20000)
    const out: any[] = []
    let lastRid = typeof opts.afterRid === 'number' ? opts.afterRid : -1
    let done = false
    while (out.length < maxRows) {
      const batch = await this.execQuery(kind, path, `${sql} WHERE m.rowid > ${lastRid}${timeCond} ORDER BY m.rowid ASC LIMIT 2000`)
      if (!batch.success) return { success: false, error: batch.error }
      const rows = batch.rows || []
      if (rows.length === 0) { done = true; break }
      for (const row of rows) {
        const serverIdRaw = row.server_id ?? row.msg_svr_id ?? row.msgSvrId ?? row.MsgSvrID ?? null
        const compact: Record<string, any> = {
          __rid: row.__rid,
          local_id: row.local_id ?? row.localId ?? null,
          // CAST AS TEXT 后缺失的 server_id 表现为 '0'，归一为 null 保持缺失语义
          server_id: serverIdRaw === 0 || serverIdRaw === '0' ? null : serverIdRaw,
          create_time: coerceRowNumber(row.create_time, 0),
          is_send: row.is_send ?? null,
          sender_username: row.sender_username ?? null,
          localType: this.resolveLocalType(row),
          content: decodeMessageContent(row.message_content, row.compress_content)
        }
        for (const c of pickedExtras) compact[c] = row[c]
        out.push(compact)
      }
      lastRid = rows[rows.length - 1].__rid
      if (rows.length < 2000) { done = true; break }
    }
    return { success: true, rows: out, lastRid, done }
  }

  /** 兼容不同微信版本的 local_type 列名与字符串类型值 */
  private resolveLocalType(row: Record<string, any>, fallback = 1): number {
    let zeroCandidate: number | undefined
    for (const fieldName of MSG_TYPE_COLUMNS) {
      const value = getRowField(row, [fieldName])
      if (value === null || value === undefined || value === '') continue
      const parsed = coerceRowNumber(value, Number.NaN)
      if (!Number.isFinite(parsed)) continue
      if (parsed > 0) return parsed
      if (parsed === 0 && zeroCandidate === undefined) zeroCandidate = parsed
    }
    return zeroCandidate ?? fallback
  }

  async getSnsTimeline(limit: number, offset: number, usernames?: string[], keyword?: string, startTime?: number, endTime?: number): Promise<{ success: boolean; timeline?: any[]; error?: string }> {
    if (!this.initialized || this.handle === null) {
      return { success: false, error: 'WCDB 未初始化' }
    }
    try {
      const outJson = [null]
      const usernamesJson = usernames && usernames.length > 0 ? JSON.stringify(usernames) : ''
      const result = this.wcdbGetSnsTimeline(
        this.handle,
        limit,
        offset,
        usernamesJson,
        keyword || '',
        startTime || 0,
        endTime || 0,
        outJson
      )
      if (result !== 0) {
        return { success: false, error: this.mapStatusCode(result) }
      }
      if (!outJson[0]) {
        return { success: true, timeline: [] }
      }
      const jsonStr = this.koffi.decode(outJson[0], 'char', -1)
      this.wcdbFreeString(outJson[0])
      return { success: true, timeline: JSON.parse(jsonStr) }
    } catch (e: any) {
      return { success: false, error: e.message || String(e) }
    }
  }

  private decodeJsonPtr(outPtr: any): string | null {
    if (!outPtr) return null
    try {
      const jsonStr = this.koffi.decode(outPtr, 'char', -1)
      this.wcdbFreeString(outPtr)
      return jsonStr
    } catch {
      try { this.wcdbFreeString(outPtr) } catch { /* ignore */ }
      return null
    }
  }

  private parseMessageJson(jsonStr: string): any[] {
    const raw = String(jsonStr || '')
    if (!raw) return []
    const needsInt64Normalize = /"server_id"\s*:\s*-?\d{16,}/.test(raw)
    const normalized = needsInt64Normalize
      ? raw.replace(/("server_id"\s*:\s*)(-?\d{16,})/g, '$1"$2"')
      : raw
    const parsed = JSON.parse(normalized)
    return Array.isArray(parsed) ? parsed : [parsed]
  }

  async getNativeMessages(sessionId: string, limit: number, offset: number): Promise<{ success: boolean; rows?: any[]; error?: string }> {
    return { success: false, error: 'direct native 消息读取已禁用，请使用 cursor 路径' }
  }

  // ============== 命名管道监控 ==============
  /**
   * 启动 native 侧的命名管道监控并订阅事件回调。
   * 若 native 未导出管道相关符号则返回 false（功能降级）。
   */
  setMonitor(callback: (type: string, json: string) => void): boolean {
    if (!this.wcdbStartMonitorPipe) {
      return false
    }
    this.monitorCallback = callback
    try {
      const result = this.wcdbStartMonitorPipe()
      if (result !== 0) {
        return false
      }

      let pipePath = process.platform === 'win32'
        ? '\\\\.\\pipe\\ciphertalk_monitor'
        : '/tmp/weflow_monitor_pipe'
      if (this.wcdbGetMonitorPipeName) {
        try {
          const namePtr = [null as any]
          if (this.wcdbGetMonitorPipeName(namePtr) === 0 && namePtr[0]) {
            pipePath = this.koffi.decode(namePtr[0], 'char', -1)
            this.wcdbFreeString(namePtr[0])
          }
        } catch {
          // ignore，落回默认管道名
        }
      }
      this.connectMonitorPipe(pipePath)
      return true
    } catch (e) {
      console.error('[wcdbCore] setMonitor exception:', e)
      return false
    }
  }

  private connectMonitorPipe(pipePath: string): void {
    this.monitorPipePath = pipePath
    const net = require('net')

    setTimeout(() => {
      if (!this.monitorCallback) return

      this.monitorPipeClient = net.createConnection(this.monitorPipePath, () => {})

      let buffer = ''
      this.monitorPipeClient.on('data', (data: Buffer) => {
        const rawChunk = data.toString('utf8')
        const normalizedChunk = rawChunk
          .replace(/\u0000/g, '\n')
          .replace(/}\s*{/g, '}\n{')

        buffer += normalizedChunk
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() || ''
        for (const line of lines) {
          if (line.trim()) {
            try {
              const parsed = JSON.parse(line)
              this.monitorCallback?.(parsed.action || 'update', line)
            } catch {
              this.monitorCallback?.('update', line)
            }
          }
        }

        const tail = buffer.trim()
        if (tail.startsWith('{') && tail.endsWith('}')) {
          try {
            const parsed = JSON.parse(tail)
            this.monitorCallback?.(parsed.action || 'update', tail)
            buffer = ''
          } catch {
            // 不可解析则继续等待下一块数据
          }
        }
      })

      this.monitorPipeClient.on('error', () => {
        // 保持静默，交由 close 回调触发重连
      })

      this.monitorPipeClient.on('close', () => {
        this.monitorPipeClient = null
        this.scheduleReconnect()
      })
    }, 100)
  }

  private scheduleReconnect(): void {
    if (this.monitorReconnectTimer || !this.monitorCallback) return
    this.monitorReconnectTimer = setTimeout(() => {
      this.monitorReconnectTimer = null
      if (this.monitorCallback && !this.monitorPipeClient) {
        this.connectMonitorPipe(this.monitorPipePath)
      }
    }, 3000)
  }

  stopMonitor(): void {
    this.monitorCallback = null
    if (this.monitorReconnectTimer) {
      clearTimeout(this.monitorReconnectTimer)
      this.monitorReconnectTimer = null
    }
    if (this.monitorPipeClient) {
      try {
        this.monitorPipeClient.destroy()
      } catch {
        // ignore
      }
      this.monitorPipeClient = null
    }
    if (this.wcdbStopMonitorPipe) {
      try {
        this.wcdbStopMonitorPipe()
      } catch {
        // ignore
      }
    }
  }

  // ============== 日志 / 错误码 ==============
  private async printLogs(): Promise<string> {
    try {
      if (!this.wcdbGetLogs) return ''
      const outPtr = [null as any]
      const result = this.wcdbGetLogs(outPtr)
      if (result === 0 && outPtr[0]) {
        const jsonStr = this.koffi.decode(outPtr[0], 'char', -1)
        // console.error('WCDB 内部日志:', jsonStr)
        this.wcdbFreeString(outPtr[0])
        return jsonStr
      }
    } catch (e) {
      console.error('获取 WCDB 日志失败:', e)
    }
    return ''
  }

  private mapStatusCode(code: number): string {
    switch (code) {
      case 0: return '成功'
      case -1: return '参数错误'
      case -2: return '密钥错误'
      case -3:
      case -4: return '数据库打开失败'
      case -5: return '查询执行失败'
      case -6: return 'WCDB 尚未初始化'
      case -7: return 'WCDB 表结构不匹配'
      case -8: return '软件偷来的吧！'
      case -9: return '签名到期，停止使用'
      case -10: return '靠，你从哪搞得软件？'
      case -11: return '首次必须联网获取时间'
      case -12: return '签名无效'
      case -13: return '请勿使用盗版'
      case -14: return '您已被禁用'
      case -15: return '已停用'
      case -16: return '云端授权服务请求失败'
      case -17: return '当前 CipherTalk 版本不受支持，请更新后重试'
      case -18: return '当前 WCDB 原生库版本不受支持，请更新软件后重试'
      default: return `WCDB 错误码: ${code}`
    }
  }

}
