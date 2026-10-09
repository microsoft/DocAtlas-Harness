import { describe, expect, it } from 'vitest'

import {
  capabilitiesRequest,
  DOCUMENT_RPC_VERSION,
  healthRequest,
  isCapabilitiesSuccess,
  isHealthSuccess,
  SIDECAR_PROTOCOL_VERSION,
  SIDECAR_SERVICE,
} from '../src/index.ts'

describe('sidecar protocol', () => {
  it('builds an explicit health request', () => {
    expect(healthRequest('startup-1')).toEqual({
      jsonrpc: '2.0',
      id: 'startup-1',
      method: 'health',
      params: {},
    })
  })

  it('builds an explicit capabilities request', () => {
    expect(capabilitiesRequest('capabilities-1')).toEqual({
      jsonrpc: '2.0',
      id: 'capabilities-1',
      method: 'capabilities',
      params: {},
    })
  })

  it('accepts only the pinned service and protocol', () => {
    expect(isHealthSuccess({
      jsonrpc: '2.0',
      id: 'startup-1',
      result: {
        protocolVersion: SIDECAR_PROTOCOL_VERSION,
        service: SIDECAR_SERVICE,
        status: 'ok',
      },
    })).toBe(true)
    expect(isHealthSuccess({
      jsonrpc: '2.0',
      id: 'startup-1',
      result: {
        protocolVersion: '2.0.0',
        service: SIDECAR_SERVICE,
        status: 'ok',
      },
    })).toBe(false)
  })

  it('accepts capabilities only for the negotiated protocol family', () => {
    const response = {
      jsonrpc: '2.0',
      id: 'capabilities-1',
      result: {
        schemaVersion: 1,
        resultType: 'capabilities',
        protocolVersion: SIDECAR_PROTOCOL_VERSION,
        documentRpcVersion: DOCUMENT_RPC_VERSION,
        service: SIDECAR_SERVICE,
        status: 'ok',
        methods: ['health', 'capabilities'],
        readModes: [],
        providerCapabilities: [],
        limits: {
          maxConcurrentRead: 4,
          maxConcurrentIngest: 1,
          maxRequestBytes: 1_048_576,
          maxDocumentBytes: 536_870_912,
          maxTextResultChars: 20_000,
          maxImagePixels: 40_000_000,
        },
        runtime: {
          implementation: 'cpython',
          pythonVersion: '3.12.12',
          packageVersion: '0.0.0',
        },
      },
    }
    expect(isCapabilitiesSuccess(response)).toBe(true)
    expect(isCapabilitiesSuccess({
      ...response,
      result: { ...response.result, methods: ['health'] },
    })).toBe(false)
  })
})
