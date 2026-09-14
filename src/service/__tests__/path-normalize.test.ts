import { describe, expect, it } from 'vitest'
import { normalizeAbsPath, samePath } from '../path-normalize.js'

describe('normalizeAbsPath', () => {
  it('win32 统一盘符大小写与分隔符', () => {
    expect(normalizeAbsPath('c:/repo', 'win32')).toBe('C:\\repo')
    expect(normalizeAbsPath('C:\\Repo', 'win32')).toBe('C:\\Repo')
    expect(normalizeAbsPath('c:\\Repo\\', 'win32')).toBe('C:\\Repo')
  })

  it('win32 折叠 . 与 ..', () => {
    expect(normalizeAbsPath('c:\\a\\.\\b\\..\\c', 'win32')).toBe('C:\\a\\c')
  })

  it('win32 保留 UNC 前导双反斜杠', () => {
    expect(normalizeAbsPath('\\\\server\\share\\proj', 'win32')).toBe('\\\\server\\share\\proj')
  })

  it('win32 去除首尾空白', () => {
    expect(normalizeAbsPath('  c:/repo  ', 'win32')).toBe('C:\\repo')
  })

  it('POSIX 保持大小写并折叠冗余段', () => {
    expect(normalizeAbsPath('/Users/x/./Repo/', 'linux')).toBe('/Users/x/Repo')
    expect(normalizeAbsPath('/Users/x/repo', 'linux')).toBe('/Users/x/repo')
  })

  it('相对路径基于注入的 cwd 解析', () => {
    expect(normalizeAbsPath('repo', 'linux', '/work')).toBe('/work/repo')
    expect(normalizeAbsPath('repo', 'win32', 'C:\\work')).toBe('C:\\work\\repo')
  })
})

describe('samePath', () => {
  it('win32 大小写不敏感', () => {
    expect(samePath('C:\\Repo', 'c:\\repo', 'win32')).toBe(true)
    expect(samePath('C:\\Repo', 'C:\\Other', 'win32')).toBe(false)
  })

  it('POSIX 大小写敏感', () => {
    expect(samePath('/Repo', '/repo', 'linux')).toBe(false)
    expect(samePath('/repo', '/repo', 'linux')).toBe(true)
  })
})
