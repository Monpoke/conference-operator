import { defineStore } from 'pinia'
import { ref } from 'vue'

export interface ConfirmRequest {
  title: string
  message: string
  confirmLabel: string
  danger?: boolean
}

/** The console's question before a gesture that cannot be taken back; answered in `ConfirmHost`. */
export const useConfirmStore = defineStore('confirm', () => {
  const request = ref<ConfirmRequest | null>(null)
  let settle: ((answer: boolean) => void) | null = null

  function answer(value: boolean): void {
    settle?.(value)
    settle = null
    request.value = null
  }
  /** Resolves to the operator's answer. A question still open counts as refused. */
  function ask(next: ConfirmRequest): Promise<boolean> {
    settle?.(false)
    request.value = next
    return new Promise((resolve) => {
      settle = resolve
    })
  }

  return { request, ask, answer }
})
