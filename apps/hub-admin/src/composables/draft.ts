import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'

/**
 * A panel's working copy, which the refresh leaves alone once touched.
 *
 * `useSeededField` protects one field by its focus. A loop panel is a whole
 * structure — pages, rows, logos — edited over several minutes with clicks in
 * between: focus says nothing there. What protects it is having changed
 * something: a dirty draft is never replaced by what the hub answers, a clean
 * one follows it.
 *
 * `reset()` takes the hub's value back, dirty or not: it is what a save calls,
 * once the hub has answered.
 */
export function useDraft<T extends object>(
  source: () => T | null,
): { draft: Ref<T | null>; dirty: ComputedRef<boolean>; reset: () => void } {
  const draft = ref(null) as Ref<T | null>
  const base = ref('null')
  const dirty = computed(() => draft.value != null && JSON.stringify(draft.value) !== base.value)

  function reset(): void {
    const value = source()
    base.value = JSON.stringify(value)
    draft.value = value == null ? null : (JSON.parse(base.value) as T)
  }

  watch(
    () => JSON.stringify(source()),
    () => {
      if (!dirty.value) reset()
    },
    { immediate: true },
  )

  return { draft, dirty, reset }
}
