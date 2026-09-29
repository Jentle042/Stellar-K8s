import http from 'kk6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'kk6/metrics';

// Custom metrics
export const rpcErrorRate = new Rate('rpc_error_rate');
export const gasUsedTrend = new Trend('gas_used_trend');

export const options = {
    stages: [
        { duration: '10s', target: 5 },  // Ramp-up: 5 VUs
        { duration: '30s', target: 50 }, // Spike: 50 VUs (should trigger autoscaling)
        { duration: '30s', target: 50 }, // Sustained high load
        { duration: '20s', target: 5 },  // Cooldown
    ],
    thresholds: {
        http_req_duration: ['p(95)<2000'], // 95% of requests must complete within 2s
        rpc_error_rate: ['rate<0.05'],     // RPC error rate must be < 5%
    },
};

export default function () {
    // Determine the Soroban RPC endpoint (defaulting to local test cluster)
    const baseUrl = __ENV.SOROBAN_RPC_URL || 'http://localhost:8000';

    const payload = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getTransactions',
        params: {
            startLedger: 1000,
            limit: 100
        },
    });

    const params = {
        headers: {
            'Content-Type': 'application/json',
        },
    };

    const res = http.post(baseUrl, payload, params);

    // Track RPC errors
    const isError = res.status !== 200 || (res.json() && res.json().error !== undefined);
    rpcErrorRate.add(isError);

    check(res, {
        'status is 200': (r) => r.status === 200,
        'has result': (r) => r.json() && r.json().result !== undefined,
    });

    // Extract gas usage from the REC response when available.
    // Soroban RPC returns meta.ledgerRetention and transaction meta including fees.
    let gasUsed = 0;
    try {
        const body = res.json();
        if (body && body.result && Array.isArray(body.result.transactions)) {
            for (const tx of body.result.transactions) {
                if (tx && tx.meta && tx.meta.feeCharged) {
                    gasUsed += Number(tx.meta.feeCharged);
                }
            }
        }
    } catch (e) {
        // Ignore malformed JSON; error rate already captured above.
    }
    gasUsedTrend.add(gasUsed);

    sleep(1); // 1 second between requests per VU
}
