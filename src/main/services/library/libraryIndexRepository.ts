import type { LibraryFileCorrection, LibraryIndex } from '../../../shared/contracts'
import {
  readLibraryIndex,
  readLibraryIndexBackup,
  readLibraryIndexBackupDate,
  writeLibraryCorrection,
  writeLibraryIndex
} from '../localStore'

export interface LibraryIndexRepository {
  read(): Promise<LibraryIndex | null>
  readBackup(): Promise<LibraryIndex | null>
  readBackupDate(): Promise<string | null>
  write(index: LibraryIndex, previousIndex?: LibraryIndex | null): Promise<void>
  writeCorrection(
    fileId: string,
    correction: LibraryFileCorrection
  ): Promise<LibraryIndex>
}

export function createJsonLibraryIndexRepository(
  dataDirectory: () => string
): LibraryIndexRepository {
  return {
    read: () => readLibraryIndex(dataDirectory()),
    readBackup: () => readLibraryIndexBackup(dataDirectory()),
    readBackupDate: () => readLibraryIndexBackupDate(dataDirectory()),
    write: (index, previousIndex) =>
      writeLibraryIndex(dataDirectory(), index, previousIndex),
    writeCorrection: (fileId, correction) =>
      writeLibraryCorrection(dataDirectory(), fileId, correction)
  }
}
