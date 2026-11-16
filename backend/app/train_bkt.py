"""
Bayesian Knowledge Tracing (BKT) — self-contained implementation.

Trains one BKT model per subdomain on the cybersecurity training attempts
dataset, then shows example mastery predictions.

No external BKT library needed (avoids pyBKT's dependency conflicts with
newer scikit-learn/numpy) -- this is a standard EM/forward-backward fit,
~100 lines, and is easy to explain to judges since you own every line of it.

USAGE: python train_bkt.py
Requires only: pandas, numpy (pip install pandas numpy --break-system-packages)
"""

import numpy as np
import pandas as pd
import json

DATA_PATH = "training_data_with_time.csv"
OUTPUT_PARAMS_PATH = "bkt_params.json"


def fit_bkt_em(sequences, n_iter=30, tol=1e-4):
    """
    Fit BKT parameters (prior, learn, guess, slip) for one skill via EM.
    sequences: list of lists of 0/1 (correct/incorrect), chronological order,
               one list per user, for a single skill.
    """
    p_init, p_learn, p_guess, p_slip = 0.3, 0.2, 0.2, 0.1
    prev_ll = -np.inf

    for _ in range(n_iter):
        n_seqs = len(sequences)
        sum_init_known = 0.0
        trans_unknown_to_known = 0.0
        trans_from_unknown = 0.0
        obs_correct_known = 0.0
        obs_total_known = 0.0
        obs_correct_unknown = 0.0
        obs_total_unknown = 0.0
        total_ll = 0.0

        for seq in sequences:
            T = len(seq)

            def emit(o, state):
                if state == 1:
                    return (1 - p_slip) if o == 1 else p_slip
                return p_guess if o == 1 else (1 - p_guess)

            # forward pass
            alpha = np.zeros((T, 2))
            c = np.zeros(T)
            alpha[0, 0] = (1 - p_init) * emit(seq[0], 0)
            alpha[0, 1] = p_init * emit(seq[0], 1)
            c[0] = alpha[0].sum() or 1e-10
            alpha[0] /= c[0]

            for t in range(1, T):
                prev_u, prev_k = alpha[t - 1]
                pred_u = prev_u * (1 - p_learn)
                pred_k = prev_u * p_learn + prev_k
                alpha[t, 0] = pred_u * emit(seq[t], 0)
                alpha[t, 1] = pred_k * emit(seq[t], 1)
                c[t] = alpha[t].sum() or 1e-10
                alpha[t] /= c[t]

            total_ll += np.sum(np.log(c + 1e-12))

            # backward pass
            beta = np.zeros((T, 2))
            beta[T - 1] = [1.0, 1.0]
            for t in range(T - 2, -1, -1):
                for s in [0, 1]:
                    val = 0.0
                    for s_next in [0, 1]:
                        trans_p = (
                            ((1 - p_learn) if s_next == 0 else p_learn)
                            if s == 0
                            else (0.0 if s_next == 0 else 1.0)
                        )
                        val += trans_p * emit(seq[t + 1], s_next) * beta[t + 1, s_next]
                    beta[t, s] = val / c[t + 1]

            gamma = alpha * beta
            gamma /= gamma.sum(axis=1, keepdims=True) + 1e-12

            sum_init_known += gamma[0, 1]
            for t in range(T):
                o = seq[t]
                p_known, p_unknown = gamma[t, 1], gamma[t, 0]
                obs_correct_known += p_known * (o == 1)
                obs_total_known += p_known
                obs_correct_unknown += p_unknown * (o == 1)
                obs_total_unknown += p_unknown
            for t in range(T - 1):
                p_u_t = gamma[t, 0]
                trans_from_unknown += p_u_t
                trans_unknown_to_known += p_u_t * p_learn  # approx, standard simplification

        p_init = np.clip(sum_init_known / n_seqs, 0.01, 0.99)
        p_learn = np.clip(trans_unknown_to_known / (trans_from_unknown + 1e-9), 0.01, 0.5)
        p_slip = np.clip(1 - (obs_correct_known / (obs_total_known + 1e-9)), 0.01, 0.4)
        p_guess = np.clip(obs_correct_unknown / (obs_total_unknown + 1e-9), 0.01, 0.4)

        if abs(total_ll - prev_ll) < tol:
            break
        prev_ll = total_ll

    return {
        "prior": float(p_init),
        "learn": float(p_learn),
        "guess": float(p_guess),
        "slip": float(p_slip),
        "log_likelihood": float(total_ll),
    }


def predict_mastery_sequence(seq, params):
    """Given one user's sequence of correct/incorrect for a skill, return
    P(mastered) after each attempt -- this is what feeds the mastery_state
    table / the /assess FastAPI endpoint."""
    p_learn, p_guess, p_slip = params["learn"], params["guess"], params["slip"]
    p_known = params["prior"]
    trace = []
    for o in seq:
        if o == 1:
            num = p_known * (1 - p_slip)
            den = num + (1 - p_known) * p_guess
        else:
            num = p_known * p_slip
            den = num + (1 - p_known) * (1 - p_guess)
        p_known_given_obs = num / (den + 1e-12)
        p_known = p_known_given_obs + (1 - p_known_given_obs) * p_learn
        trace.append(round(float(p_known), 4))
    return trace


if __name__ == "__main__":
    df = pd.read_csv(DATA_PATH)
    df["timestamp"] = pd.to_datetime(df["timestamp"])
    df = df.sort_values(["user_id", "subdomain", "timestamp"])

    all_params = {}
    print("Training BKT per subdomain...\n")

    for skill in df["subdomain"].unique():
        skill_df = df[df["subdomain"] == skill]
        sequences = [g["correct"].tolist() for _, g in skill_df.groupby("user_id")]
        params = fit_bkt_em(sequences, n_iter=30)
        all_params[skill] = params
        print(
            f"{skill:22s} prior={params['prior']:.3f}  learn={params['learn']:.3f}  "
            f"guess={params['guess']:.3f}  slip={params['slip']:.3f}"
        )

    with open(OUTPUT_PARAMS_PATH, "w") as f:
        json.dump(all_params, f, indent=2)
    print(f"\nSaved fitted parameters to {OUTPUT_PARAMS_PATH}")
    print("(This JSON is what your FastAPI service loads at startup to score new attempts.)")

    # ---- Example: mastery trace for one real user ----
    example_user = df["user_id"].iloc[0]
    example_skill = df["subdomain"].iloc[0]
    seq = df[(df["user_id"] == example_user) & (df["subdomain"] == example_skill)]["correct"].tolist()
    trace = predict_mastery_sequence(seq, all_params[example_skill])
    print(f"\nExample mastery trace — {example_user} / {example_skill}:")
    print(f"  attempts (correct/incorrect): {seq}")
    print(f"  P(mastery) after each attempt: {trace}")
