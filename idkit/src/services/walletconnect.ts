/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import create from 'zustand'
import { useEffect } from 'react'
import { buildQRData } from '@/lib/qr'
import { randomNumber } from '@/lib/utils'
import type { OrbResponse } from '@/types/orb'
import Client from '@walletconnect/sign-client'
import { getSdkError } from '@walletconnect/utils'
import type { ExpectedErrorResponse } from '@/types'
import type { StringOrAdvanced } from '@/types/config'
import { OrbErrorCodes, VerificationState } from '@/types/orb'
import { validateABILikeEncoding, worldIDHash } from '@/lib/hashing'

type WalletConnectStore = {
	connected: boolean
	uri: string
	topic: string
	result: OrbResponse | null
	errorCode: OrbErrorCodes | null
	verificationState: VerificationState
	config: { action_id: StringOrAdvanced; signal: StringOrAdvanced } | null
	qrData: {
		default: string
		mobile: string
	} | null

	initConnection: (action_id: StringOrAdvanced, signal: StringOrAdvanced) => Promise<void>
	onConnectionEstablished: () => Promise<void>
	setUri: (uri: string) => void
}

let client: Client

const useWalletConnectStore = create<WalletConnectStore>()((set, get) => ({
	qrData: null,
	config: null,
	result: null,
	connected: false,
	uri: '',
	topic: '',
	errorCode: null,
	verificationState: VerificationState.LoadingWidget,

	initConnection: async (action_id: StringOrAdvanced, signal: StringOrAdvanced) => {
		set({ config: { action_id, signal } })

		// TODO: Move metadata to .env vars
		client = await Client.init({
			projectId: 'c3e6053f10efbb423808783ee874cf6a',
			metadata: {
				name: 'IDKit',
				description: 'Testing IDKit w/ WalletConnect v2',
				url: '#',
				icons: ['https://walletconnect.com/walletconnect-logo.png'],
			},
		})

		console.log('client:', client) // DEBUG

		try {
			const { uri, approval } = await client.connect({
				requiredNamespaces: {
					eip155: {
						methods: ['wld_worldIDVerification'],
						chains: ['eip155:0'],
						events: ['chainChanged', 'accountsChanged'],
					},
				},
			})

			if (uri) {
				console.log('uri:', uri) // DEBUG
				console.log('approval:', approval) //DEBUG

				get().setUri(uri as string)

				const session = await approval()

				console.log('session:', session)

				if (session) {
					set({ topic: session.topic })

					console.log('topic:', get().topic)

					return get().onConnectionEstablished()
				}

				client.on('session_delete', event => {
					console.log('session_delete:', event)
					void get().initConnection(action_id, signal)
				})
			}
		} catch (error) {
			set({ errorCode: OrbErrorCodes.ConnectionFailed })
			console.error(`Unable to establish a connection with the WLD app: ${error}`)
		}
	},

	setUri: (uri: string) => {
		if (!uri) return

		console.log('uri:', uri) // DEBUG

		set({
			uri: uri,
			verificationState: VerificationState.AwaitingConnection,
			qrData: {
				default: buildQRData(uri),
				mobile: buildQRData(uri, window.location.href),
			},
		})
	},
	onConnectionEstablished: async () => {
		set({ verificationState: VerificationState.AwaitingVerification })

		console.log('onConnectionEstablished()')

		await client
			.request({
				topic: get().topic,
				chainId: 'eip155:0',
				// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
				request: buildVerificationRequest(get().config!.action_id, get().config!.signal),
			})
			.then(result => {
				console.log('result:', result)
				if (!ensureVerificationResponse(result)) return set({ errorCode: OrbErrorCodes.UnexpectedResponse })

				set({ result, verificationState: VerificationState.Confirmed })
			})
			.catch((error: unknown) => {
				console.log('error:', error)
				let errorCode = OrbErrorCodes.GenericError

				const errorMessage = (error as ExpectedErrorResponse).message
				if (errorMessage && Object.values(OrbErrorCodes).includes(errorMessage as OrbErrorCodes)) {
					errorCode = errorMessage as OrbErrorCodes
				}

				set({ errorCode, verificationState: VerificationState.Failed })
			})
			.finally(
				async () => await client.disconnect({ topic: get().topic, reason: getSdkError('USER_DISCONNECTED') })
			)
			.catch(error => console.error('Unable to kill session', error))
	},
}))

const buildVerificationRequest = (action_id: StringOrAdvanced, signal: StringOrAdvanced) => ({
	jsonrpc: '2.0',
	method: 'wld_worldIDVerification',
	id: randomNumber(100000, 9999999),
	params: [{ signal: worldIDHash(signal).digest, action_id: worldIDHash(action_id).digest }],
})

const ensureVerificationResponse = (result: Record<string, string | undefined>): result is OrbResponse => {
	const proof = 'proof' in result ? result.proof : undefined
	const merkle_root = 'merkle_root' in result ? result.merkle_root : undefined
	const nullifier_hash = 'nullifier_hash' in result ? result.nullifier_hash : undefined

	for (const attr of [merkle_root, nullifier_hash, proof]) {
		if (!attr || !validateABILikeEncoding(attr)) return false
	}

	return true
}

type UseOrbSignalResponse = {
	result: OrbResponse | null
	errorCode: OrbErrorCodes | null
	verificationState: VerificationState
	qrData: {
		default: string
		mobile: string
	} | null
}

const getStore = (store: WalletConnectStore) => ({
	qrData: store.qrData,
	result: store.result,
	errorCode: store.errorCode,
	initConnection: store.initConnection,
	verificationState: store.verificationState,
})

const useOrbSignal = (action_id: StringOrAdvanced, signal: StringOrAdvanced): UseOrbSignalResponse => {
	const { result, verificationState, errorCode, qrData, initConnection } = useWalletConnectStore(getStore)

	useEffect(() => {
		if (!action_id || !signal) return

		void initConnection(action_id, signal)
	}, [action_id, initConnection, signal])

	return { result, verificationState, errorCode, qrData }
}

export default useOrbSignal
