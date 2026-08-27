"""
Built-in demo — a modern agentic system, no LLM or API key required.

Exposed as ``agent-visualizer demo``. It declares its own floor (registry,
vector store, an MCP server, an eval harness, guardrails) so it doubles as a
demonstration of dynamic rooms rather than only of agents walking around.
"""

from __future__ import annotations

import time

from .client import AgentVisualizerClient, DEFAULT_SERVER_URL

ROOMS = [
    {"id": "gateway", "label": "GATEWAY", "kind": "gateway", "capacity": 4},
    {"id": "registry", "label": "AGENT REGISTRY", "kind": "registry", "capacity": 4},
    {"id": "vectors", "label": "VECTOR STORE", "kind": "memory", "capacity": 6},
    {"id": "mcp_github", "label": "MCP GITHUB", "kind": "mcp", "capacity": 4},
    {"id": "llm", "label": "MODEL CALLS", "kind": "llm", "capacity": 6},
    {"id": "evals", "label": "EVAL HARNESS", "kind": "eval", "capacity": 6},
    {"id": "guardrails", "label": "GUARDRAILS", "kind": "guardrail", "capacity": 3},
    {"id": "output", "label": "ARTIFACTS", "kind": "output", "capacity": 4},
]

MCP_TOOLS = ["list_issues", "get_file_contents", "create_pull_request"]


def run(server_url: str = DEFAULT_SERVER_URL, pace: float = 1.0) -> None:
    """Play the scripted scenario against a running bridge."""

    def beat(seconds: float = 1.4) -> None:
        """Give the sprites time to finish walking before the next instruction."""
        time.sleep(seconds * pace)

    vis = AgentVisualizerClient(server_url, client_name="demo")

    # Start from a clean world, then describe this system's own floor.
    vis.reset()
    beat(0.4)
    vis.define_world(ROOMS)
    beat(0.8)

    planner = vis.register("planner_1", name="Planner", role="planner", avatar_type="mage")
    scout = vis.register("scout_1", name="Retriever", role="researcher", avatar_type="rogue")
    smith = vis.register("smith_1", name="Tool Runner", role="operator", avatar_type="artificer")
    judge = vis.register("judge_1", name="Evaluator", role="critic", avatar_type="knight")
    beat(1.0)

    print(f"connected={vis.connected}  transport={vis.stats['transport']}")
    if not vis.connected:
        print("!! bridge not reachable - start it with `agent-visualizer serve`")

    planner.speak("Objective received. Checking the registry.", interaction_type="broadcast")
    beat()

    # --- registry ---------------------------------------------------------
    planner.move_to(zone="registry")
    planner.update_state("Resolving agent registry",
                         detail='registry.list(capabilities=["search", "code"])',
                         metrics={"tokens": 180, "latency_ms": 90})
    beat(2.0)
    planner.speak("Retriever, pull context from the vector store.",
                  to="scout_1", interaction_type="handoff")
    beat(2.2)

    # --- retrieval --------------------------------------------------------
    scout.move_to(zone="vectors")
    scout.update_state("Searching memory",
                       detail="vector_store.similarity_search(k=8)",
                       metrics={"tokens": 420, "latency_ms": 260, "documents": 8})
    beat(2.2)
    scout.speak("8 documents retrieved. Over to you.", to="smith_1", interaction_type="handoff")
    beat(2.2)

    # --- MCP server -------------------------------------------------------
    smith.move_to(zone="mcp_github")
    tokens = 600
    for tool in MCP_TOOLS:
        tokens += 190
        smith.update_state(f"Executing Tool: {tool}",
                           detail=f"mcp://github/{tool}",
                           metrics={"tokens": tokens, "latency_ms": 140})
        beat(1.3)
        smith.speak(f"{tool} returned 200 OK", interaction_type="response")
        beat(0.9)

    # --- model call -------------------------------------------------------
    planner.move_to(zone="llm")
    planner.update_state("Thinking",
                         detail="Drafting the patch summary from 8 documents and 3 tool results.",
                         metrics={"tokens": 2140, "latency_ms": 1830})
    beat(2.2)
    planner.speak("Draft ready. Grade it.", to="judge_1", interaction_type="request")
    beat(2.2)

    # --- evaluation: four agents in one room, i.e. the crowding case -------
    for handle in (judge, scout, smith, planner):
        handle.move_to(zone="evals")
    judge.update_state("Scoring against rubric",
                       detail="faithfulness 0.94, relevance 0.88, 12 criteria",
                       metrics={"tokens": 980, "latency_ms": 640})
    beat(2.6)
    judge.speak("11 of 12 criteria pass. One revision needed.",
                to="planner_1", interaction_type="response")
    beat(2.2)

    # --- guardrails -------------------------------------------------------
    judge.move_to(zone="guardrails")
    judge.update_state("Policy check",
                       detail="pii clean, secrets clean, licence ok",
                       metrics={"tokens": 140, "latency_ms": 70})
    beat(2.0)

    vis.graph_edge("planner_1", "scout_1", weight=2.0, label="retrieve")
    vis.graph_edge("scout_1", "smith_1", weight=2.0, label="tools")
    vis.graph_edge("smith_1", "judge_1", weight=1.5, label="grade")

    # --- deliver ----------------------------------------------------------
    planner.move_to(zone="output", speed=1.2)
    planner.update_state("Complete",
                         detail="PR #482 opened with the revised patch.",
                         metrics={"tokens": 3980, "latency_ms": 118, "cost_usd": 0.064})
    beat(2.2)
    planner.speak("Artifact stored. PR #482 is open.", interaction_type="broadcast")
    beat(1.5)

    print("demo finished:", vis.stats)
    vis.close()


if __name__ == "__main__":  # pragma: no cover
    run()
