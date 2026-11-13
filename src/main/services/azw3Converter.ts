import { execFile } from 'node:child_process'
import { lstat, rename, rm, stat } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

const CONVERSION_TIMEOUT_MS = 30 * 60 * 1000
const MAX_CONVERTER_OUTPUT_BYTES = 10 * 1024 * 1024

async function findCalibreConverter(): Promise<string> {
  const executableName = process.platform === 'win32' ? 'ebook-convert.exe' : 'ebook-convert'
  const candidates = process.platform === 'win32'
    ? [
        process.env.ProgramFiles ? join(process.env.ProgramFiles, 'Calibre2', executableName) : '',
        process.env['ProgramFiles(x86)'] ? join(process.env['ProgramFiles(x86)']!, 'Calibre2', executableName) : '',
        ...(process.env.PATH ?? '').split(delimiter).filter(Boolean).map((directory) => join(directory, executableName))
      ]
    : (process.env.PATH ?? '').split(delimiter).filter(Boolean).map((directory) => join(directory, executableName))

  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      const details = await lstat(candidate)
      if (details.isFile() && !details.isSymbolicLink()) return candidate
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue
      throw error
    }
  }
  throw new Error('Calibre was not found. Install Calibre with ebook-convert available on PATH, then try again.')
}

function runConverter(
  executable: string,
  inputPath: string,
  outputPath: string,
  outputFormat: 'EPUB' | 'AZW3'
): Promise<void> {
  return new Promise((resolveConversion, rejectConversion) => {
    execFile(
      executable,
      [inputPath, outputPath],
      {
        timeout: CONVERSION_TIMEOUT_MS,
        maxBuffer: MAX_CONVERTER_OUTPUT_BYTES,
        windowsHide: true
      },
      (error, _stdout, stderr) => {
        if (error) {
          const details = String(stderr).trim()
          rejectConversion(new Error(
            `Calibre could not convert this book to ${outputFormat}: ${details || error.message}`
          ))
          return
        }
        resolveConversion()
      }
    )
  })
}

async function convertToFormat(
  inputPath: string,
  outputPath: string,
  extension: 'epub' | 'azw3',
  outputFormat: 'EPUB' | 'AZW3'
): Promise<{ outputPath: string; outputBytes: number }> {
  const temporaryPath = join(
    dirname(outputPath),
    `.novel-tracker-${randomUUID()}.tmp.${extension}`
  )
  try {
    await runConverter(await findCalibreConverter(), inputPath, temporaryPath, outputFormat)
    const details = await stat(temporaryPath)
    if (!details.isFile() || details.size === 0) {
      throw new Error(`Calibre reported success but did not create a readable ${outputFormat} file.`)
    }
    await rename(temporaryPath, outputPath)
    return { outputPath, outputBytes: details.size }
  } finally {
    await rm(temporaryPath, { force: true })
  }
}

export function convertEpubToAzw3(inputPath: string, outputPath: string) {
  return convertToFormat(inputPath, outputPath, 'azw3', 'AZW3')
}

export function convertAzw3ToEpub(inputPath: string, outputPath: string) {
  return convertToFormat(inputPath, outputPath, 'epub', 'EPUB')
}
