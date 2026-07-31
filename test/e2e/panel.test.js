// Drives the real expand-view page (compiled SVG + media assets) in headless
// Chromium and verifies the interactive behavior end to end.
// Requires a browser: npx playwright install chromium

require('../helpers/hook');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');
const { mkItem } = require('../helpers/fixtures');
const { toGraph } = require('../../out/callGraph/model.js');
const { renderSvg } = require('../../out/callGraph/svg.js');
const { flowPanelHtml } = require('../../out/panel/html.js');

const REPO = path.join(__dirname, '..', '..');

function buildPanelHtml() {
    const root = mkItem('handleConflicts', 'invoice.controller.ts');
    const outTree = {
        item: root,
        children: [
            {
                item: mkItem('update', 'invoice.service.ts'),
                children: [{ item: mkItem('updateDb', 'invoice-database.ts'), children: [] }],
            },
            { item: mkItem('getService', 'invoice.controller.ts'), children: [] },
        ],
    };
    const inTree = {
        item: root,
        children: [
            {
                item: mkItem('editInvoice', 'invoice.controller.ts'),
                children: [{ item: mkItem('route', 'invoice.route.ts'), children: [] }],
            },
        ],
    };
    const callerGraph = toGraph(inTree, root.uri);
    const calleeGraph = toGraph(outTree, root.uri);
    const svg = renderSvg(callerGraph, calleeGraph, true);
    return flowPanelHtml({
        svgMarkup: svg.markup,
        legend: '<span class="lgi"><i style="background:#9d7cd8"></i>service</span>',
        anchor: svg.rootAnchor,
        hasParents: false,
        styleUri: 'file://' + path.join(REPO, 'media', 'styles.css'),
        scriptUri: 'file://' + path.join(REPO, 'media', 'main.js'),
        cspSource: 'file:',
    });
}

test('expand view page', async (t) => {
    const htmlPath = path.join(os.tmpdir(), `call-charts-e2e-${process.pid}.html`);
    fs.writeFileSync(htmlPath, buildPanelHtml());
    const browser = await chromium.launch();
    const page = await browser.newPage();
    const problems = [];
    page.on('console', (message) => {
        if (message.type() === 'error') {
            problems.push('console: ' + message.text());
        }
    });
    page.on('pageerror', (error) => problems.push('pageerror: ' + error.message));
    await page.addInitScript(() => {
        window.__posts = [];
        window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posts.push(m) });
    });
    await page.goto('file://' + htmlPath);
    await page.waitForTimeout(400);

    const hoverNode = async (id) => {
        const handle = await page.evaluateHandle(
            (nodeId) => [...document.querySelectorAll('.fn-node')].find((el) => el.dataset.nodeId === nodeId),
            id
        );
        await handle.asElement().hover();
    };
    const posts = () => page.evaluate(() => window.__posts);
    const packetCount = () => page.evaluate(() => document.querySelectorAll('svg > circle').length);

    await t.test('marker and parents button anchor to the opened function', async () => {
        const state = await page.evaluate(() => {
            const texts = [...document.querySelectorAll('svg text')].map((el) => el.textContent);
            const button = document.getElementById('parentsBtn');
            const buttonRect = button.getBoundingClientRect();
            const rootRect = [...document.querySelectorAll('.fn-node')]
                .find((el) => !el.dataset.parentId)
                .getBoundingClientRect();
            return {
                hasMarker: texts.includes('you are here'),
                buttonText: button.textContent,
                isBelowRoot: buttonRect.top > rootRect.bottom,
                isCentered: Math.abs(buttonRect.left + buttonRect.width / 2 - (rootRect.left + rootRect.width / 2)) < 8,
            };
        });
        assert.equal(state.hasMarker, true);
        assert.equal(state.buttonText, '⟨ show parents');
        assert.equal(state.isBelowRoot, true);
        assert.equal(state.isCentered, true);
    });

    await t.test('parents button asks the host to load callers', async () => {
        await page.click('#parentsBtn');
        assert.deepEqual(await posts(), [{ type: 'callers', shouldShow: true }]);
    });

    await t.test('hovering a node runs the packet trace and requests details', async () => {
        await hoverNode('n2');
        await page.waitForTimeout(450);
        assert.ok((await packetCount()) > 0, 'packets are flowing');
        const sent = await posts();
        const request = sent.find((m) => m.type === 'details');
        assert.ok(request, 'details request sent after hover intent');
        assert.equal(request.nodeId, 'n2');
        assert.ok(request.parentUri, 'request carries the hovered edge parent');
    });

    await t.test('the details card renders the host reply', async () => {
        await page.evaluate(() => {
            window.postMessage(
                {
                    type: 'details',
                    nodeId: 'n2',
                    details: {
                        name: 'updateDb',
                        location: 'invoice-database.ts:64',
                        signature: 'async updateDb(id: string): Promise<Invoice>',
                        groups: [
                            { kind: 'out', entries: ['InvoiceModel.findByIdAndUpdate(id)'] },
                            { kind: 'callers', entries: ['update'] },
                        ],
                        facts: ['async', '12 lines'],
                    },
                },
                '*'
            );
        });
        await page.waitForTimeout(150);
        const card = await page.evaluate(() => ({
            isOpen: document.getElementById('card').classList.contains('open'),
            rows: document.querySelectorAll('#card .row').length,
            chips: document.querySelectorAll('#card .chip').length,
        }));
        assert.deepEqual(card, { isOpen: true, rows: 2, chips: 2 });
    });

    await t.test('invalidate clears the card cache so details are re-requested', async () => {
        await page.mouse.move(0, 0);
        await page.waitForTimeout(300);
        await page.evaluate(() => window.postMessage({ type: 'invalidate' }, '*'));
        await hoverNode('n2');
        await page.waitForTimeout(450);
        const sent = await posts();
        const detailRequests = sent.filter((m) => m.type === 'details' && m.nodeId === 'n2');
        assert.equal(detailRequests.length, 2, 'a fresh request after invalidation');
    });

    await t.test('leaving a node stops the trace and closes the card', async () => {
        await page.mouse.move(0, 0);
        await page.waitForTimeout(300);
        assert.equal(await packetCount(), 0);
        assert.equal(await page.evaluate(() => document.getElementById('card').classList.contains('open')), false);
    });

    await t.test('the page raised no console or security errors', () => {
        assert.deepEqual(problems, []);
    });

    await browser.close();
    fs.unlinkSync(htmlPath);
});
