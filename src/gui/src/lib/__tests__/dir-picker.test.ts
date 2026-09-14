import { describe, expect, it } from 'vitest'
import { isValidDirName, joinDir, splitBreadcrumb } from '../dir-picker.js'

describe('splitBreadcrumb', () => {
  it('POSIX 路径逐级展开，根段为 /', () => {
    expect(splitBreadcrumb('/Users/me/code', '/')).toEqual([
      { label: '/', path: '/' },
      { label: 'Users', path: '/Users' },
      { label: 'me', path: '/Users/me' },
      { label: 'code', path: '/Users/me/code' },
    ])
  })

  it('POSIX 根本身只有一段', () => {
    expect(splitBreadcrumb('/', '/')).toEqual([{ label: '/', path: '/' }])
  })

  it('win32 盘符根段落跳转到 C:\\', () => {
    expect(splitBreadcrumb('C:\\work\\repo', '\\')).toEqual([
      { label: 'C:', path: 'C:\\' },
      { label: 'work', path: 'C:\\work' },
      { label: 'repo', path: 'C:\\work\\repo' },
    ])
  })

  it('win32 盘符根本身只有一段', () => {
    expect(splitBreadcrumb('C:\\', '\\')).toEqual([{ label: 'C:', path: 'C:\\' }])
  })

  it('win32 UNC 以 \\\\server\\share 为根', () => {
    expect(splitBreadcrumb('\\\\server\\share\\proj', '\\')).toEqual([
      { label: '\\\\server\\share', path: '\\\\server\\share' },
      { label: 'proj', path: '\\\\server\\share\\proj' },
    ])
  })

  it('盘符列表层（空串）返回空数组', () => {
    expect(splitBreadcrumb('', '\\')).toEqual([])
  })
})

describe('joinDir', () => {
  it('POSIX 普通目录与根目录都不产生双斜杠', () => {
    expect(joinDir('/Users/me', 'code', '/')).toBe('/Users/me/code')
    expect(joinDir('/', 'Users', '/')).toBe('/Users')
  })

  it('win32 盘符根不重复插入反斜杠', () => {
    expect(joinDir('C:\\', 'work', '\\')).toBe('C:\\work')
    expect(joinDir('C:\\work', 'repo', '\\')).toBe('C:\\work\\repo')
  })

  it('盘符列表层直接取盘符路径', () => {
    expect(joinDir('', 'C:\\', '\\')).toBe('C:\\')
  })
})

describe('isValidDirName', () => {
  it('接受普通目录名（含空白包裹与中文）', () => {
    expect(isValidDirName('repo')).toBe(true)
    expect(isValidDirName('  my-repo  ')).toBe(true)
    expect(isValidDirName('我的项目')).toBe(true)
    expect(isValidDirName('.hidden')).toBe(true)
  })

  it('拒绝空串、点目录与含分隔符的名称', () => {
    expect(isValidDirName('')).toBe(false)
    expect(isValidDirName('   ')).toBe(false)
    expect(isValidDirName('.')).toBe(false)
    expect(isValidDirName('..')).toBe(false)
    expect(isValidDirName('a/b')).toBe(false)
    expect(isValidDirName('a\\b')).toBe(false)
    expect(isValidDirName('../escape')).toBe(false)
  })
})
