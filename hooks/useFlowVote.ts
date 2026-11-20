"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useConfig, usePublicClient } from "wagmi";
import { getAccount, getWalletClient, switchChain } from "@wagmi/core";
import { encodeFunctionData, formatEther, zeroAddress, type Address, type Hash } from "viem";
import { celo } from "viem/chains";
import { IDENTITY_ABI, IDENTITY_CONTRACT, PROJECT_NAME, PROJECT_RECIPIENT, FLOW_ABI, FLOW_CHAIN, FLOW_COUNCIL, buildFlowVote, flowAllocation, flowClaimMessage, flowSnapshotKey, matchesFlowVoteTransaction, type FlowMetadata, type FlowSnapshot, type FlowVote } from "@/lib/flowstate";

type ErrLike = { code?: unknown; name?: unknown; message?: unknown; shortMessage?: unknown; cause?: unknown };
function isUserRejectedTx(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as ErrLike;
  if (e.code === 4001 || e.name === "UserRejectedRequestError") return true;
  if (typeof e.message === "string" && /user rejected|rejected the request|user denied|user cancel|request rejected/i.test(e.message)) return true;
  return isUserRejectedTx(e.cause);
}
function isInsufficientFunds(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as ErrLike;
  const text = [e.message, e.shortMessage, e.name].filter(v => typeof v === "string").join(" ");
  return /insufficient funds|insufficient balance|exceeds balance|gas required exceeds|InsufficientFunds/i.test(text) || isInsufficientFunds(e.cause);
}

type Pending = { hash: Hash; amount: string };
type Review = { snapshotKey: string; amount: string; votes: FlowVote[]; fee: string };
const pendingKey = (address: Address) => `flow-vote:${FLOW_CHAIN}:${FLOW_COUNCIL}:${address.toLowerCase()}`;
async function json(response: Response) {
  const data = await response.json().catch(() => null);
  if (!data || typeof data !== "object") throw new Error("Voting service returned an incomplete response. Please retry.");
  if (!response.ok) throw new Error(data.error ?? "Voting service is unavailable. Please retry.");
  return data;
}

// Mounted with key=wallet so changes never carry a review or a pending ballot
// onto another account. All writes additionally recheck the live connector.
export function useFlowVote(address: Address) {
  const config = useConfig();
  const client = usePublicClient({ chainId: FLOW_CHAIN });
  const [metadata, setMetadata] = useState<FlowMetadata | null>(null);
  const [snapshot, setSnapshot] = useState<FlowSnapshot | null>(null);
  const [amount, setAmountState] = useState("");
  const [review, setReview] = useState<Review | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [confirmed, setConfirmed] = useState<Pending | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const mounted = useRef(true), running = useRef(false);
  const assertOwner = useCallback(() => {
    if (!mounted.current || getAccount(config).address?.toLowerCase() !== address.toLowerCase()) throw new Error("Your wallet changed. Reopen voting with the account you want to use.");
  }, [address, config]);
  useEffect(() => {
    mounted.current = true;
    try {
      const saved = JSON.parse(localStorage.getItem(pendingKey(address)) ?? "null");
      if (saved && /^0x[0-9a-f]{64}$/i.test(saved.hash) && /^\d{1,29}$/.test(saved.amount)) setPending(saved);
    } catch { /* A blocked localStorage does not stop the in-memory recovery. */ }
    return () => { mounted.current = false; };
  }, [address]);

  const readSnapshot = useCallback(async (): Promise<FlowSnapshot> => {
    if (!client) throw new Error("Celo connection is unavailable. Please retry.");
    const [voter, votes, maxSpread, root, recipient] = await Promise.all([
      client.readContract({ address: FLOW_COUNCIL, abi: FLOW_ABI, functionName: "getVoter", args: [address] }),
      client.readContract({ address: FLOW_COUNCIL, abi: FLOW_ABI, functionName: "getVotes", args: [address] }),
      client.readContract({ address: FLOW_COUNCIL, abi: FLOW_ABI, functionName: "maxVotingSpread" }),
      client.readContract({ address: IDENTITY_CONTRACT, abi: IDENTITY_ABI, functionName: "getWhitelistedRoot", args: [address] }),
      client.readContract({ address: FLOW_COUNCIL, abi: FLOW_ABI, functionName: "getRecipient", args: [PROJECT_RECIPIENT] }),
    ]);
    return { votingPower: voter.votingPower, votes, maxSpread, verified: root !== zeroAddress, recipientActive: recipient.account.toLowerCase() === PROJECT_RECIPIENT };
  }, [address, client]);

  const refresh = useCallback(async () => {
    const [meta, state] = await Promise.all([fetch("/api/flowstate", { cache: "no-store" }).then(json), readSnapshot()]);
    assertOwner();
    setMetadata(meta); setSnapshot(state); setReview(null);
    const allocation = flowAllocation(state);
    setAmountState(allocation.current > 0n ? String(allocation.current) : allocation.maximum > 0n ? "1" : "");
    return state;
  }, [assertOwner, readSnapshot]);

  async function run(label: string, action: () => Promise<void>) {
    if (running.current) return;
    running.current = true; setBusy(label); setError(""); setNotice("");
    try { assertOwner(); await action(); }
    catch (err) {
      if (mounted.current) {
        if (isUserRejectedTx(err)) setNotice("Cancelled. No new vote was submitted.");
        else if (isInsufficientFunds(err)) setError("Your wallet needs a little CELO for the network fee. Add CELO to this same wallet, then retry.");
        else setError(err instanceof Error && err.message.length < 260 ? err.message : "Couldn’t complete this step. Refresh your voting status and try again.");
      }
    } finally { running.current = false; if (mounted.current) setBusy(""); }
  }

  useEffect(() => {
    let cancelled = false;
    setBusy("Checking voting status…");
    refresh().catch(() => { if (!cancelled) setError("Couldn’t load your voting status. Please retry."); }).finally(() => { if (!cancelled) setBusy(""); });
    return () => { cancelled = true; };
  }, [refresh]);

  async function wallet() {
    assertOwner();
    if (getAccount(config).chainId !== FLOW_CHAIN) await switchChain(config, { chainId: FLOW_CHAIN });
    assertOwner();
    const signer = await getWalletClient(config, { chainId: FLOW_CHAIN });
    if (signer.account.address.toLowerCase() !== address.toLowerCase()) throw new Error("Your wallet changed. Please refresh.");
    return signer;
  }

  const claim = () => run("Confirm voting rights…", async () => {
    const state = await refresh();
    if (!state.verified) throw new Error("Complete GoodDollar verification first.");
    if (state.votingPower > 0n) { setNotice("Your voting rights are already active."); return; }
    const signer = await wallet();
    const issuedAt = Date.now();
    const signature = await signer.signMessage({ account: address, message: flowClaimMessage(address, issuedAt) });
    assertOwner(); setBusy("Activating your voting rights…");
    await fetch("/api/flowstate", { method: "POST", headers: { "Content-Type": "application/json", "x-flow-vote": "1" }, body: JSON.stringify({ address, issuedAt, signature }), signal: AbortSignal.timeout(25_000) }).then(json);
    const updated = await refresh();
    setNotice(updated.votingPower > 0n ? "Voting rights active. Choose your allocation below." : "Registration received. Refresh status in a moment to load your votes.");
  });

  const prepare = () => run("Preparing your ballot…", async () => {
    if (!client || !metadata) throw new Error("Refresh voting details first.");
    const state = await readSnapshot();
    assertOwner(); setSnapshot(state);
    const votes = buildFlowVote(state, amount);
    const data = encodeFunctionData({ abi: FLOW_ABI, functionName: "vote", args: [votes] });
    await client.simulateContract({ account: address, address: FLOW_COUNCIL, abi: FLOW_ABI, functionName: "vote", args: [votes] });
    const [gas, gasPrice, balance] = await Promise.all([
      client.estimateGas({ account: address, to: FLOW_COUNCIL, data }), client.getGasPrice(), client.getBalance({ address }),
    ]);
    assertOwner();
    const estimated = gas * gasPrice * 12n / 10n;
    if (balance < estimated) throw new Error("Your wallet needs a little CELO for the network fee. Add CELO to this same wallet, then retry.");
    setReview({ snapshotKey: flowSnapshotKey(state), amount: votes[0].amount.toString(), votes, fee: formatEther(estimated) });
  });

  async function finishReceipt(record: Pending, wait: boolean) {
    if (!client) throw new Error("Celo connection is unavailable.");
    let receipt;
    try { receipt = wait ? await client.waitForTransactionReceipt({ hash: record.hash, confirmations: 1, timeout: 45_000 }) : await client.getTransactionReceipt({ hash: record.hash }); }
    catch {
      if (mounted.current) setNotice("Your vote was submitted, but confirmation is still pending. Check its status below; do not submit again.");
      return;
    }
    if (receipt.status === "success") {
      // A replacement may be a cancellation, or a saved hash may be malformed.
      // A successful receipt alone is not evidence that this ballot was cast.
      let tx;
      try { tx = await client.getTransaction({ hash: receipt.transactionHash }); }
      catch {
        if (mounted.current) setNotice("The receipt arrived, but the ballot transaction could not be verified yet. Check its status again.");
        return;
      }
      if (!matchesFlowVoteTransaction(address, record.amount, tx)) {
        try { localStorage.removeItem(pendingKey(address)); } catch { /* optional */ }
        if (mounted.current) { setPending(null); setReview(null); }
        throw new Error("This transaction did not cast the reviewed vote. Refresh your ballot before trying again.");
      }
    }
    // Persisted state is wallet-scoped, even if the player navigated away while
    // the receipt was in flight. Never allow a pending hash to trigger a resend.
    try { localStorage.removeItem(pendingKey(address)); } catch { /* optional persistence */ }
    if (!mounted.current) return;
    assertOwner(); setPending(null); setReview(null);
    if (receipt.status !== "success") throw new Error("The vote transaction reverted. Refresh your ballot before retrying. A network fee may have been charged.");
    setConfirmed({ ...record, hash: receipt.transactionHash }); setNotice(`Your vote is confirmed on Celo. Thank you for supporting ${PROJECT_NAME}.`);
    try { await refresh(); } catch { setNotice("Your vote is confirmed on Celo. The latest ballot could not be refreshed yet."); }
  }

  const submit = () => run("Confirm your vote…", async () => {
    if (!review || pending || !client) return;
    const signer = await wallet();
    const state = await readSnapshot();
    assertOwner();
    if (flowSnapshotKey(state) !== review.snapshotKey) {
      setSnapshot(state); setReview(null);
      throw new Error("Your ballot or voting eligibility changed. Review your allocation again before confirming.");
    }
    const votes = buildFlowVote(state, review.amount);
    await client.simulateContract({ account: address, address: FLOW_COUNCIL, abi: FLOW_ABI, functionName: "vote", args: [votes] });
    assertOwner();
    const hash = await signer.writeContract({ chain: celo, account: address, address: FLOW_COUNCIL, abi: FLOW_ABI, functionName: "vote", args: [votes] });
    const record = { hash, amount: review.amount };
    try { localStorage.setItem(pendingKey(address), JSON.stringify(record)); } catch { /* Keep the hash in the visible pending state. */ }
    if (!mounted.current) return;
    setPending(record); setReview(null); setBusy("Waiting for confirmation…");
    await finishReceipt(record, true);
  });

  return { metadata, snapshot, amount, setAmount: (value: string) => { setAmountState(value); setReview(null); setConfirmed(null); }, review, cancelReview: () => setReview(null), pending, confirmed, busy, error, notice,
    refresh: () => run("Refreshing voting status…", async () => { await refresh(); }), claim, prepare, submit,
    checkPending: () => run("Checking your submitted vote…", async () => { if (pending) await finishReceipt(pending, false); }),
  };
}
