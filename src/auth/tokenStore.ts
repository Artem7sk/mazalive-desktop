import Store from 'electron-store'

interface StoreSchema {
  sessionToken: string
  userId: string
  userName: string
  userEmail: string
  userImage: string
  tokenSavedAt: number
}

const store = new Store<StoreSchema>({
  name: 'mazalive-auth',
  encryptionKey: 'mazalive-encrypt-key-2025', // в продакшене — используй уникальный ключ
})

export const tokenStore = {
  save(data: {
    sessionToken: string
    userId: string
    userName: string
    userEmail: string
    userImage: string
  }) {
    store.set('sessionToken', data.sessionToken)
    store.set('userId', data.userId)
    store.set('userName', data.userName)
    store.set('userEmail', data.userEmail)
    store.set('userImage', data.userImage)
    store.set('tokenSavedAt', Date.now())
  },

  getToken(): string | null {
    return (store.get('sessionToken', '') as string) || null
  },

  getUser() {
    return {
      id: store.get('userId', '') as string,
      name: store.get('userName', '') as string,
      email: store.get('userEmail', '') as string,
      image: store.get('userImage', '') as string,
    }
  },

  isLoggedIn(): boolean {
    const token = this.getToken()
    if (!token) return false
    // Проверяем, что токен сохранён не более 30 дней назад
    const savedAt = store.get('tokenSavedAt', 0) as number
    const thirtyDays = 30 * 24 * 60 * 60 * 1000
    return Date.now() - savedAt < thirtyDays
  },

  clear() {
    store.clear()
  },
}
