"""
Built-in demo — a three-agent research crew, no LLM or API key required.

Exposed as ``agent-visualizer demo`` so a new user can see the thing work
without writing a file first.
"""

from __future__ import annotations

import random
import time

from .client import AgentVisualizerClient, DEFAULT_SERVER_URL

TOOLS = ["WebSearch", "PythonREPL", "SQLQuery", "HttpFetch"]


def run(server_url: str = DEFAULT_SERVER_URL, pace: float = 1.0) -> None:
    """Play the scripted scenario against a running bridge."""

    def beat(seconds: float = 1.4) -> None:
        """Give the sprites time to finish walking before the next instruction."""
        time.sleep(seconds * pace)

    vis = AgentVisualizerClient(server_url, client_name="demo")

    # Start from a clean world so re-running the demo does not stack agents.
    vis.reset()
    beat(0.4)

    scout = vis.register("scout_1", name="Scout", role="scout",
                         avatar_type="rogue", initial_pos={"x": 2, "y": 3})
    mage = vis.register("mage_1", name="Archivist", role="researcher",
                        avatar_type="mage", initial_pos={"x": 3, "y": 2})
    smith = vis.register("smith_1", name="Toolsmith", role="operator",
                         avatar_type="artificer", initial_pos={"x": 2, "y": 2})
    beat(1.0)

    print(f"connected={vis.connected}  transport={vis.stats['transport']}")
    if not vis.connected:
        print("!! bridge not reachable — start it with `agent-visualizer serve`")

    scout.speak("New objective received. Fanning out.", interaction_type="broadcast")
    beat()

    # --- Scout gathers ----------------------------------------------------
    scout.move_to(zone="library")
    scout.update_state("Searching memory", metrics={"tokens": 120, "latency_ms": 210})
    beat(2.0)
    scout.speak("Three candidate sources in the archive.", to="mage_1")
    beat(2.4)

    # --- Archivist reads --------------------------------------------------
    mage.move_to(zone="library")
    mage.update_state("Reading: vector_store", metrics={"tokens": 480, "latency_ms": 340})
    beat(2.2)
    mage.speak("Source #2 looks authoritative.", to="smith_1", interaction_type="handoff")
    beat(2.4)

    # --- Toolsmith executes -----------------------------------------------
    total_tokens = 0
    for i, tool in enumerate(TOOLS):
        smith.move_to(zone="tools")
        total_tokens += random.randint(80, 260)
        smith.update_state(
            f"Executing Tool: {tool}",
            detail=f"call #{i + 1} -> {tool}(query='target node')",
            metrics={"tokens": total_tokens, "latency_ms": random.randint(90, 420)},
        )
        beat(1.6)
        smith.speak(f"{tool} returned 200 OK", interaction_type="response")
        beat(1.0)

    # --- Converge in the council ------------------------------------------
    vis.graph_edge("scout_1", "mage_1", weight=2.0, label="findings")
    vis.graph_edge("mage_1", "smith_1", weight=1.5, label="handoff")
    vis.graph_edge("smith_1", "scout_1", weight=1.0, label="results")

    for handle in (scout, mage, smith):
        handle.move_to(zone="council")
    beat(2.6)

    mage.speak("Consensus reached — writing the answer.", to="scout_1")
    beat(2.2)

    # --- Deliver ------------------------------------------------------------
    mage.move_to(zone="vault")
    mage.update_state("Complete",
                      metrics={"tokens": 1_240, "latency_ms": 118, "cost_usd": 0.021})
    beat(2.2)
    mage.speak("Artifact stored in the vault.", interaction_type="broadcast")
    beat(1.5)

    print("demo finished:", vis.stats)
    vis.close()


if __name__ == "__main__":  # pragma: no cover
    run()
