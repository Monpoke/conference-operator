import { ref, watch, type Ref } from 'vue'

/**
 * A form field the ten-second refresh must not overwrite mid-sentence.
 *
 * Every panel of the settings view had this by hand: read the store, but skip
 * the write if the field currently has focus. Nothing is more disorienting than
 * a field that rewrites itself while somebody is typing into it — and the
 * console refreshes under the operator's hands all day.
 *
 * Focus is the right test rather than "has been touched": leaving the field is
 * exactly the moment a change made elsewhere — another operator, an import —
 * should become visible.
 */
export function useSeededField(
  source: () => string,
  elementId: string,
): { value: Ref<string>; reseed: () => void } {
  const value = ref(source())

  function focused(): boolean {
    const element = globalThis.document?.getElementById(elementId)
    return element != null && element === globalThis.document.activeElement
  }

  function reseed(): void {
    if (!focused()) value.value = source()
  }

  watch(source, reseed)

  return { value, reseed }
}
