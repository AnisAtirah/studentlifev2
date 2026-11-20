import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { signInAnonymously, signInWithPopup } from 'firebase/auth'
import LoginPage from './LoginPage'

// Fake Firebase so the tests never open a popup or hit the network.
vi.mock('./firebase', () => ({ auth: {}, googleProvider: {} }))
vi.mock('firebase/auth', () => ({
  signInWithPopup: vi.fn(),
  signInAnonymously: vi.fn(),
}))

describe('LoginPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // Test 1: does the page show up?
  it('shows both sign-in buttons', () => {
    render(<LoginPage />)
    expect(screen.getByRole('button', { name: /sign in with google/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /try as guest/i })).toBeInTheDocument()
  })

  // Test 2: the Google button starts the Google popup
  it('signs in with Google when the Google button is clicked', async () => {
    signInWithPopup.mockResolvedValue({})
    render(<LoginPage />)
    await userEvent.click(screen.getByRole('button', { name: /sign in with google/i }))
    expect(signInWithPopup).toHaveBeenCalledTimes(1)
  })

  // Test 3: the guest button signs in anonymously
  it('signs in as a guest when the guest button is clicked', async () => {
    signInAnonymously.mockResolvedValue({})
    render(<LoginPage />)
    await userEvent.click(screen.getByRole('button', { name: /try as guest/i }))
    expect(signInAnonymously).toHaveBeenCalledTimes(1)
  })

  // Test 4: a Firebase error shows a friendly message
  it('shows an error message when sign-in fails', async () => {
    signInWithPopup.mockRejectedValue({ code: 'auth/network-request-failed' })
    render(<LoginPage />)
    await userEvent.click(screen.getByRole('button', { name: /sign in with google/i }))
    expect(await screen.findByText(/no internet connection/i)).toBeInTheDocument()
  })

  // Test 5: closing the popup is not treated as an error
  it('shows no error when the user closes the popup', async () => {
    signInWithPopup.mockRejectedValue({ code: 'auth/popup-closed-by-user' })
    render(<LoginPage />)
    await userEvent.click(screen.getByRole('button', { name: /sign in with google/i }))
    expect(screen.queryByText(/failed|connection/i)).not.toBeInTheDocument()
  })
})
