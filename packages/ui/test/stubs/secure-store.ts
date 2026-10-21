// The native module cannot load under vitest; the web path (localStorage) is the one tests exercise.
export const getItemAsync = async (_key: string): Promise<string | null> => null
export const setItemAsync = async (_key: string, _value: string): Promise<void> => undefined
export const deleteItemAsync = async (_key: string): Promise<void> => undefined
