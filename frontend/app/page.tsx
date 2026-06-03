'use client';

import { useState, useEffect, useCallback, useRef, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useAccount, useSendTransaction } from 'wagmi';
import { parseEther } from 'viem';
import axios from 'axios';

const API = process.env.NEXT_PUBLIC_BACKEND_URL;

interface Market {
  slug: string;
  title: string | null;
  ticker: string | null;
  yes_price: number | null;
  no_price: number | null;
  strike_price: string | null;
  deadline: string | null;
}

interface NewsItem {
  title: string;
  link: string;
  pubDate: string;
}

interface TradeProposal {
  slug: string;
  side: string;
  amount_usdc: number;
  estimated_price: number | null;
  estimated_shares: number | null;
  message: string;
}

function TimeAgo({ date }: { date: string }) {
  const [label, setLabel] = useState('');
  useEffect(() => {
    const update = () => {
      const diff = Date.now() - new Date(date).getTime();
      const m = Math.floor(diff / 60000);
      const h = Math.floor(diff / 3600000);
      const d = Math.floor(diff / 86400000);
      if (m < 1) setLabel('just now');
      else if (m < 60) setLabel(`${m}m ago`);
      else if (h < 24) setLabel(`${h}h ago`);
      else setLabel(`${d}d ago`);
    };
    update();
    const t = setInterval(update, 30000);
    return () => clearInterval(t);
  }, [date]);
  return <span>{label}</span>;
}

function ConfidenceBar({ yes, no }: { yes: number; no: number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '9px', color: 'var(--text3)', letterSpacing: '1px' }}>
        <span style={{ color: 'var(--green)' }}>YES {(yes * 100).toFixed(0)}%</span>
        <span style={{ color: 'var(--red)' }}>NO {(no * 100).toFixed(0)}%</span>
      </div>
      <div style={{ height: '4px', borderRadius: '2px', background: 'var(--bg)', overflow: 'hidden', position: 'relative' }}>
        <div style={{
          position: 'absolute', left: 0, top: 0, height: '100%',
          width: `${yes * 100}%`,
          background: yes >= 0.7 ? 'var(--green)' : yes >= 0.4 ? 'var(--yellow)' : 'var(--red)',
          borderRadius: '2px',
          transition: 'width 0.5s ease',
        }} />
      </div>
    </div>
  );
}

function HomeInner() {
  const { isConnected } = useAccount();
  const { sendTransaction } = useSendTransaction();
  const searchParams = useSearchParams();
  const autoLoaded = useRef(false);

  const [markets, setMarkets] = useState<Market[]>([]);
  const [news, setNews] = useState<NewsItem[]>([]);
  const [proposal, setProposal] = useState<TradeProposal | null>(null);
  const [selectedMarket, setSelectedMarket] = useState<Market | null>(null);
  const [side, setSide] = useState<'YES' | 'NO'>('YES');
  const [amount, setAmount] = useState('10');
  const [keyword, setKeyword] = useState('BTC');
  const [loading, setLoading] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'markets' | 'news'>('markets');
  const [tick, setTick] = useState(0);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  useEffect(() => {
    const t = setInterval(() => setTick(x => x + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const fetchMarkets = useCallback(async () => {
    setLoading(true);
    try {
      const keywords = keyword === 'BTC' ? ['BTC', 'ETH', 'SOL'] : [keyword];
      const results = await Promise.all(
        keywords.map(kw => axios.get(`${API}/api/markets/search?keyword=${kw}`).catch(() => null))
      );
      const seen = new Set<string>();
      const merged: Market[] = [];
      for (const res of results) {
        if (!res) continue;
        for (const m of (res.data.markets || [])) {
          if (!seen.has(m.slug)) {
            seen.add(m.slug);
            merged.push(m);
          }
        }
      }
      setMarkets(merged);
      setLastUpdated(new Date());
    } catch {
      setStatus('Failed to reach Node.js engine. Is it running on port 3001?');
    } finally {
      setLoading(false);
    }
  }, [keyword]);

  const fetchNews = useCallback(async () => {
    try {
      const res = await axios.get(`${API}/api/news`);
      setNews(res.data.news || []);
    } catch {}
  }, []);

  const generateProposal = useCallback(async (market: Market) => {
    setSelectedMarket(market);
    setProposal(null);
    setLoading(true);
    try {
      const res = await axios.post(`${API}/api/trade/propose`, {
        slug: market.slug,
        side,
        amount: parseFloat(amount),
      });
      setProposal(res.data);
    } catch {
      setStatus('Failed to generate proposal');
    } finally {
      setLoading(false);
    }
  }, [side, amount]);

  useEffect(() => {
    const init = async () => {
      await fetchMarkets();
      await fetchNews();
    };
    init();
    const interval = setInterval(fetchMarkets, 30000);
    return () => clearInterval(interval);
  }, [fetchMarkets, fetchNews]);

  useEffect(() => {
    if (autoLoaded.current) return;
    const slug = searchParams.get('slug');
    const sideParam = searchParams.get('side');
    if (slug && markets.length > 0) {
      const match = markets.find(m => m.slug === slug);
      if (match) {
        autoLoaded.current = true;
        setTimeout(() => {
          if (sideParam === 'YES' || sideParam === 'NO') setSide(sideParam);
          generateProposal(match);
        }, 0);
      }
    }
  }, [searchParams, markets, generateProposal]);

  const executeProposal = async () => {
    if (!proposal || !isConnected) return;
    setExecuting(true);
    setStatus('Awaiting wallet signature...');
    try {
      sendTransaction({
        to: '0x05c748E2f4DcDe0ec9Fa8DDc40DE6b867f923fa5',
        value: parseEther('0'),
        data: '0x',
      });
      setStatus('Transaction submitted! Monitor on Basescan.');
      // Notify engine to start cooldown for this user
      const tgChatId = localStorage.getItem('zd_chat_id');
      if (tgChatId) {
        axios.post(`${API}/api/trade/executed`, { chatId: tgChatId }).catch(() => {});
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      setStatus(`Error: ${msg}`);
    } finally {
      setExecuting(false);
    }
  };

  const confidenceColor = (price: number | null) => {
    if (!price) return 'var(--text3)';
    if (price >= 0.7) return 'var(--green)';
    if (price >= 0.4) return 'var(--yellow)';
    return 'var(--red)';
  };

  const getExpiry = (slug: string) => {
    if (slug.includes('5-min')) return '5 min';
    if (slug.includes('15-min')) return '15 min';
    if (slug.includes('hourly')) return '1 hour';
    if (slug.includes('daily')) return '24 hours';
    if (slug.includes('weekly')) return '7 days';
    return null;
  };

  return (
    <main style={{ minHeight: '100vh', background: 'var(--bg)', position: 'relative', overflow: 'hidden' }}>

      <div style={{
        position: 'fixed', inset: 0, zIndex: 0,
        backgroundImage: `linear-gradient(var(--border) 1px, transparent 1px), linear-gradient(90deg, var(--border) 1px, transparent 1px)`,
        backgroundSize: '40px 40px', opacity: 0.3, pointerEvents: 'none',
      }} />
      <div style={{
        position: 'fixed', top: '-20%', left: '50%', transform: 'translateX(-50%)',
        width: '600px', height: '300px',
        background: 'radial-gradient(ellipse, rgba(0,255,136,0.06) 0%, transparent 70%)',
        pointerEvents: 'none', zIndex: 0,
      }} />

      <div style={{ position: 'relative', zIndex: 1, maxWidth: '1100px', margin: '0 auto', padding: isMobile ? '16px 12px' : '24px 20px' }}>

        {/* Header */}
        <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: isMobile ? '20px' : '40px', flexWrap: 'wrap', gap: '12px' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <div style={{ width: '10px', height: '10px', borderRadius: '50%', background: 'var(--green)', boxShadow: '0 0 12px var(--green)', animation: 'pulse 2s infinite' }} />
              <h1 style={{ fontFamily: 'var(--font-display)', fontSize: isMobile ? '22px' : '28px', fontWeight: 800, letterSpacing: '-0.5px' }}>
                ZERO<span style={{ color: 'var(--green)' }}>DRIFT</span>
              </h1>
            </div>
            {!isMobile && (
              <p style={{ fontSize: '11px', color: 'var(--text3)', marginTop: '4px', letterSpacing: '2px' }}>
                AUTONOMOUS LIMITLESS ALPHA CATALYST
              </p>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
            {lastUpdated && (
              <div style={{ fontSize: '10px', color: 'var(--text3)', fontFamily: 'var(--font-mono)' }}>
                ↻ updated {lastUpdated.toLocaleTimeString()}
              </div>
            )}
            {!isMobile && (
              <div style={{ fontSize: '11px', color: 'var(--text3)', fontFamily: 'var(--font-mono)' }}>
                T+{tick}s
              </div>
            )}
            <ConnectButton />
          </div>
        </header>

        {status && (
          <div style={{ background: 'var(--surface)', border: '1px solid var(--green)', borderRadius: '4px', padding: '10px 16px', marginBottom: '20px', fontSize: '12px', color: 'var(--green)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>⚡ {status}</span>
            <button onClick={() => setStatus(null)} style={{ background: 'none', border: 'none', color: 'var(--text3)', cursor: 'pointer', fontSize: '16px' }}>×</button>
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 380px', gap: '20px' }}>

          {/* Left column */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '8px', padding: '16px 20px' }}>
              <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
                {(['markets', 'news'] as const).map(tab => (
                  <button key={tab} onClick={() => setActiveTab(tab)} style={{
                    padding: '6px 16px', borderRadius: '4px', border: '1px solid',
                    borderColor: activeTab === tab ? 'var(--green)' : 'var(--border)',
                    background: activeTab === tab ? 'rgba(0,255,136,0.08)' : 'transparent',
                    color: activeTab === tab ? 'var(--green)' : 'var(--text2)',
                    cursor: 'pointer', fontSize: '11px', fontFamily: 'var(--font-mono)',
                    letterSpacing: '1px', textTransform: 'uppercase' as const,
                  }}>{tab}</button>
                ))}
                <div style={{ flex: 1 }} />
                <button onClick={activeTab === 'markets' ? fetchMarkets : fetchNews} style={{
                  padding: '6px 12px', borderRadius: '4px', border: '1px solid var(--border)',
                  background: 'transparent', color: 'var(--text2)', cursor: 'pointer',
                  fontSize: '11px', fontFamily: 'var(--font-mono)',
                }}>↻ REFRESH</button>
              </div>
              {activeTab === 'markets' && (
                <div style={{ display: 'flex', gap: '8px' }}>
                  <input value={keyword} onChange={e => setKeyword(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && fetchMarkets()}
                    placeholder="Search markets... (BTC, ETH, SOL)"
                    style={{ flex: 1, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '4px', padding: '8px 12px', color: 'var(--text)', fontSize: '12px', fontFamily: 'var(--font-mono)', outline: 'none' }}
                  />
                  <button onClick={fetchMarkets} style={{ padding: '8px 20px', background: 'var(--green)', border: 'none', borderRadius: '4px', color: '#000', fontFamily: 'var(--font-mono)', fontSize: '12px', fontWeight: 700, cursor: 'pointer', letterSpacing: '1px' }}>
                    SCAN
                  </button>
                </div>
              )}
            </div>

            {/* Markets list */}
            {activeTab === 'markets' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {loading && <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text3)', fontSize: '12px' }}>SCANNING LIMITLESS...</div>}
                {!loading && markets.length === 0 && <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text3)', fontSize: '12px' }}>NO MARKETS FOUND</div>}
                {markets.map((market) => {
                  const expiry = getExpiry(market.slug);
                  return (
                    <div key={market.slug} onClick={() => generateProposal(market)} style={{
                      background: selectedMarket?.slug === market.slug ? 'rgba(0,255,136,0.05)' : 'var(--surface)',
                      border: '1px solid', borderColor: selectedMarket?.slug === market.slug ? 'var(--green)' : 'var(--border)',
                      borderRadius: '8px', padding: '14px 18px', cursor: 'pointer', transition: 'all 0.15s',
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: market.yes_price ? '10px' : '0' }}>
                        <div style={{ flex: 1, marginRight: '12px' }}>
                          <div style={{ fontSize: '13px', fontFamily: 'var(--font-display)', fontWeight: 600, marginBottom: '4px' }}>
                            {market.title || market.slug}
                          </div>
                          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                            <div style={{ fontSize: '10px', color: 'var(--text3)' }}>{market.slug.slice(0, 35)}...</div>
                            {expiry && (
                              <div style={{ fontSize: '9px', color: 'var(--yellow)', border: '1px solid var(--yellow)', borderRadius: '3px', padding: '1px 5px', opacity: 0.7 }}>
                                ⏱ {expiry}
                              </div>
                            )}
                          </div>
                        </div>
                        <div style={{ textAlign: 'right', flexShrink: 0 }}>
                          {market.yes_price ? (
                            <>
                              <div style={{ fontSize: '20px', fontWeight: 700, color: confidenceColor(market.yes_price), lineHeight: 1 }}>
                                {(market.yes_price * 100).toFixed(0)}%
                              </div>
                              <div style={{ fontSize: '9px', color: 'var(--text3)', marginTop: '2px' }}>YES</div>
                            </>
                          ) : (
                            <div style={{ fontSize: '10px', color: 'var(--text3)' }}>CLICK TO PRICE</div>
                          )}
                        </div>
                      </div>
                      {market.yes_price && market.no_price && (
                        <ConfidenceBar yes={market.yes_price} no={market.no_price} />
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* News list */}
            {activeTab === 'news' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {news.length === 0 && <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text3)', fontSize: '12px' }}>NO NEWS YET — ENGINE MONITORING...</div>}
                {news.map((item, i) => (
                  <a key={i} href={item.link} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'none' }}>
                    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '8px', padding: '14px 18px' }}>
                      <div style={{ fontSize: '12px', color: 'var(--text)', marginBottom: '6px', lineHeight: 1.5 }}>{item.title}</div>
                      <div style={{ fontSize: '10px', color: 'var(--text3)' }}>
                        {item.pubDate ? <TimeAgo date={item.pubDate} /> : '—'}
                      </div>
                    </div>
                  </a>
                ))}
              </div>
            )}
          </div>

          {/* Right column — Trade panel */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '8px', padding: '20px' }}>
              <div style={{ fontSize: '11px', color: 'var(--text3)', letterSpacing: '2px', marginBottom: '16px' }}>TRADE CONFIG</div>
              <div style={{ marginBottom: '12px' }}>
                <div style={{ fontSize: '10px', color: 'var(--text3)', marginBottom: '6px', letterSpacing: '1px' }}>SIDE</div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  {(['YES', 'NO'] as const).map(s => (
                    <button key={s} onClick={() => setSide(s)} style={{
                      flex: 1, padding: '8px', border: '1px solid',
                      borderColor: side === s ? (s === 'YES' ? 'var(--green)' : 'var(--red)') : 'var(--border)',
                      borderRadius: '4px',
                      background: side === s ? (s === 'YES' ? 'rgba(0,255,136,0.1)' : 'rgba(255,51,102,0.1)') : 'transparent',
                      color: side === s ? (s === 'YES' ? 'var(--green)' : 'var(--red)') : 'var(--text2)',
                      cursor: 'pointer', fontSize: '12px', fontFamily: 'var(--font-mono)', fontWeight: 700,
                    }}>{s}</button>
                  ))}
                </div>
              </div>
              <div style={{ marginBottom: '16px' }}>
                <div style={{ fontSize: '10px', color: 'var(--text3)', marginBottom: '6px', letterSpacing: '1px' }}>AMOUNT (USDC)</div>
                <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }}>
                  {['5', '10', '25', '50'].map(a => (
                    <button key={a} onClick={() => setAmount(a)} style={{
                      flex: 1, padding: '6px 4px', border: '1px solid',
                      borderColor: amount === a ? 'var(--green)' : 'var(--border)',
                      borderRadius: '4px',
                      background: amount === a ? 'rgba(0,255,136,0.08)' : 'transparent',
                      color: amount === a ? 'var(--green)' : 'var(--text2)',
                      cursor: 'pointer', fontSize: '11px', fontFamily: 'var(--font-mono)',
                    }}>${a}</button>
                  ))}
                </div>
                <input type="number" value={amount} onChange={e => setAmount(e.target.value)} style={{
                  width: '100%', background: 'var(--bg)', border: '1px solid var(--border)',
                  borderRadius: '4px', padding: '8px 12px', color: 'var(--text)',
                  fontSize: '14px', fontFamily: 'var(--font-mono)', outline: 'none',
                }} />
              </div>
              {selectedMarket && (
                <button onClick={() => generateProposal(selectedMarket)} disabled={loading} style={{
                  width: '100%', padding: '10px', background: 'transparent',
                  border: '1px solid var(--green)', borderRadius: '4px', color: 'var(--green)',
                  cursor: loading ? 'not-allowed' : 'pointer', fontSize: '11px',
                  fontFamily: 'var(--font-mono)', letterSpacing: '2px', opacity: loading ? 0.5 : 1,
                }}>{loading ? 'CALCULATING...' : '↻ RECALCULATE'}</button>
              )}
            </div>

            {/* Proposal card */}
            {proposal && (
              <div style={{ background: 'var(--surface)', border: '1px solid var(--green)', borderRadius: '8px', padding: '20px', boxShadow: '0 0 30px rgba(0,255,136,0.05)' }}>
                <div style={{ fontSize: '11px', color: 'var(--green)', letterSpacing: '2px', marginBottom: '16px' }}>TRADE PROPOSAL</div>
                <div style={{ fontSize: '13px', color: 'var(--text)', marginBottom: '8px', lineHeight: 1.6 }}>
                  {selectedMarket?.title || proposal.slug}
                </div>
                {selectedMarket && (
                  <div style={{ marginBottom: '16px' }}>
                    {(() => {
                      const expiry = getExpiry(selectedMarket.slug);
                      return expiry ? (
                        <div style={{ fontSize: '10px', color: 'var(--yellow)', marginBottom: '8px' }}>⏱ Expires in ~{expiry}</div>
                      ) : null;
                    })()}
                    {proposal.estimated_price && (
                      <ConfidenceBar
                        yes={proposal.side === 'YES' ? proposal.estimated_price : 1 - proposal.estimated_price}
                        no={proposal.side === 'YES' ? 1 - proposal.estimated_price : proposal.estimated_price}
                      />
                    )}
                  </div>
                )}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '16px' }}>
                  {[
                    { label: 'SIDE', value: proposal.side, color: proposal.side === 'YES' ? 'var(--green)' : 'var(--red)' },
                    { label: 'AMOUNT', value: `$${proposal.amount_usdc} USDC` },
                    { label: 'PRICE', value: proposal.estimated_price ? `$${proposal.estimated_price.toFixed(3)}` : '—' },
                    { label: 'SHARES', value: proposal.estimated_shares ? proposal.estimated_shares.toFixed(2) : '—' },
                  ].map(({ label, value, color }) => (
                    <div key={label} style={{ background: 'var(--bg)', borderRadius: '4px', padding: '10px 12px' }}>
                      <div style={{ fontSize: '9px', color: 'var(--text3)', letterSpacing: '1px', marginBottom: '4px' }}>{label}</div>
                      <div style={{ fontSize: '14px', fontWeight: 700, color: color || 'var(--text)' }}>{value}</div>
                    </div>
                  ))}
                </div>
                {isConnected ? (
                  <button onClick={executeProposal} disabled={executing} style={{
                    width: '100%', padding: '14px', background: 'var(--green)', border: 'none',
                    borderRadius: '4px', color: '#000', fontFamily: 'var(--font-mono)',
                    fontSize: '13px', fontWeight: 700, cursor: executing ? 'not-allowed' : 'pointer',
                    letterSpacing: '2px', opacity: executing ? 0.7 : 1,
                  }}>{executing ? 'SIGNING...' : '⚡ EXECUTE TRADE'}</button>
                ) : (
                  <div style={{ textAlign: 'center', padding: '12px', fontSize: '11px', color: 'var(--text3)', border: '1px dashed var(--border)', borderRadius: '4px' }}>
                    CONNECT WALLET TO EXECUTE
                  </div>
                )}
              </div>
            )}

            {!proposal && !selectedMarket && (
              <div style={{ background: 'var(--surface)', border: '1px dashed var(--border)', borderRadius: '8px', padding: '40px 20px', textAlign: 'center' }}>
                <div style={{ fontSize: '24px', marginBottom: '12px' }}>⚡</div>
                <div style={{ fontSize: '11px', color: 'var(--text3)', letterSpacing: '1px', lineHeight: 1.8 }}>
                  SELECT A MARKET<br />TO GENERATE A<br />TRADE PROPOSAL
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; box-shadow: 0 0 12px var(--green); }
          50% { opacity: 0.4; box-shadow: 0 0 4px var(--green); }
        }
      `}</style>
    </main>
  );
}

export default function Home() {
  return (
    <Suspense fallback={<div style={{ background: 'var(--bg)', minHeight: '100vh' }} />}>
      <HomeInner />
    </Suspense>
  );
}