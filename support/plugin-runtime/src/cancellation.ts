/** Race caller cancellation without publishing a late result from an uncooperative producer. */
export function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort),
      abort = () => {
        cleanup()
        reject(signal.reason ?? new Error('Operation cancelled'))
      }
    signal.addEventListener('abort', abort, { once: true })
    void operation.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error) => {
        cleanup()
        reject(error)
      },
    )
    if (signal.aborted) abort()
  })
}
