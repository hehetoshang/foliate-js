// Production PDF adapter, with deterministic PDF.js and range I/O doubles.
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

const hook = registerHooks({
    resolve(specifier, context, next) {
        if (specifier === '@pdfjs/pdf.min.mjs') return {
            url: 'data:text/javascript,export {};', shortCircuit: true,
        }
        return next(specifier, context)
    },
})
let state
globalThis.pdfjsLib = {
    GlobalWorkerOptions: {},
    PDFDataRangeTransport: class {
        constructor() { state.transport = this }
        onDataRange() { state.deliveries++ }
    },
    getDocument() { return state.task },
}
const { makePDF } = await import('../pdf.js')
hook.deregister()
const deferred = () => {
    let resolve, reject
    const promise = new Promise((yes, no) => { resolve = yes; reject = no })
    return { promise, resolve, reject }
}
const tick = () => new Promise(resolve => setImmediate(resolve))
const file = { size: 1024, slice: () => ({ arrayBuffer: async () => new ArrayBuffer(1) }) }
const setup = () => {
    const pdf = {
        numPages: 1,
        getPage: async () => ({ getViewport: () => ({ width: 612, height: 792 }), cleanup() {} }),
        getMetadata: async () => ({}), getViewerPreferences: async () => null,
        getOutline: async () => null, getPageLabels: async () => null,
    }
    state = { deliveries: 0, destroys: 0, pdf }
    state.task = { promise: Promise.resolve(pdf), destroy: async () => { state.destroys++ } }
}

test('PDF lifecycle', async t => {
    for (const stage of ['load', 'metadata', 'page', 'outline']) {
        await t.test(`releases loading task after ${stage} failure`, async () => {
            setup()
            const error = new Error(stage)
            if (stage === 'load') state.task.promise = Promise.reject(error)
            else state.pdf[{ metadata: 'getMetadata', page: 'getPage', outline: 'getOutline' }[stage]] = async () => { throw error }
            await assert.rejects(makePDF(file), error)
            assert.equal(state.destroys, 1)
        })
    }
    await t.test('concurrent destroy shares completion and rejection', async () => {
        setup()
        const gate = deferred()
        state.task.destroy = () => { state.destroys++; return gate.promise }
        const book = await makePDF(file)
        const first = book.destroy()
        assert.equal(book.destroy(), first)
        let completed = false
        void first.catch(() => { completed = true })
        await tick()
        assert.equal(completed, false)
        gate.reject(new Error('destroy failed'))
        await assert.rejects(first, /destroy failed/)
        await assert.rejects(book.destroy(), /destroy failed/)
        assert.equal(state.destroys, 1)
    })
    await t.test('close stops queued reads, drops late data and drains in-flight I/O', async () => {
        setup()
        const gates = []
        const book = await makePDF({ size: 1024, slice: () => ({ arrayBuffer() {
            const gate = deferred(); gates.push(gate); return gate.promise
        } }) })
        for (let i = 0; i < 12; i++) state.transport.requestDataRange(i, i + 1)
        await tick()
        assert.equal(gates.length, 6)
        let completed = false
        const closing = book.destroy().then(() => { completed = true })
        await tick()
        assert.equal(completed, false)
        for (const gate of gates) gate.resolve(new ArrayBuffer(1))
        await closing
        state.transport.requestDataRange(99, 100)
        await tick()
        assert.equal(gates.length, 6)
        assert.equal(state.deliveries, 0)
    })
    await t.test('Range failure rejects initialization and is handled', async () => {
        setup()
        state.task.promise = new Promise(() => {})
        const opening = makePDF({ size: 1024, slice: () => ({ arrayBuffer: async () => { throw new Error('range failed') } }) })
        state.transport.requestDataRange(0, 1)
        await assert.rejects(opening, /range failed/)
        assert.equal(state.destroys, 1)
    })
    await t.test('abort during loading awaits destruction', async () => {
        setup()
        state.task.promise = new Promise(() => {})
        const controller = new AbortController()
        const gate = deferred()
        state.task.destroy = () => { state.destroys++; return gate.promise }
        const opening = makePDF(file, { signal: controller.signal })
        const rejected = assert.rejects(opening, /cancel/)
        controller.abort(new Error('cancel'))
        await tick()
        gate.resolve()
        await rejected
        assert.equal(state.destroys, 1)
    })
    await t.test('normal Range requests still deliver', async () => {
        setup()
        const book = await makePDF(file)
        state.transport.requestDataRange(0, 1)
        await tick()
        assert.equal(state.deliveries, 1)
        await book.destroy()
    })
})
