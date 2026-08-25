"""
LangGraph integration demo — the whole visualization comes from one callback.

    pip install "agent-visualizer[all]" langgraph langchain-core
    agent-visualizer serve            # terminal 1
    python langgraph_demo.py          # terminal 2

No API key needed: the nodes are plain Python functions. The point of the demo
is that `VisualizerCallback` picks up each LangGraph **node** automatically
(via the `langgraph_node` metadata LangGraph attaches to every node run) and
spawns a sprite for it — you write no visualization code inside the nodes.
"""

import time
from typing import Annotated, List, TypedDict

from agent_visualizer import VisualizerCallback

try:
    from langchain_core.tools import tool
    from langgraph.graph import END, START, StateGraph
except ImportError:
    raise SystemExit(
        "This demo needs LangGraph:\n"
        "    pip install langgraph langchain-core"
    )


def merge(left: List[str], right: List[str]) -> List[str]:
    return left + right


class ResearchState(TypedDict):
    question: str
    notes: Annotated[List[str], merge]
    answer: str


@tool
def web_search(query: str) -> str:
    """Search the web for a query and return the top result."""
    time.sleep(0.8)  # pretend network latency, so the walk animation is visible
    return f"Top result for '{query}': the target node is at sector 7."


@tool
def calculator(expression: str) -> str:
    """Evaluate a simple arithmetic expression."""
    time.sleep(0.5)
    allowed = set("0123456789+-*/(). ")
    if not set(expression) <= allowed:
        return "refused: unsupported characters"
    return str(eval(expression, {"__builtins__": {}}, {}))  # noqa: S307 - demo only


# --- Nodes. Note: zero visualizer code in here. ----------------------------


def planner(state: ResearchState) -> dict:
    time.sleep(0.6)
    return {"notes": [f"Plan: decompose '{state['question']}' into search + math."]}


def scout(state: ResearchState, config=None) -> dict:
    # Passing `config` through is what lets tool calls inherit the callback and
    # be attributed to this node.
    result = web_search.invoke({"query": state["question"]}, config=config)
    return {"notes": [result]}


def analyst(state: ResearchState, config=None) -> dict:
    result = calculator.invoke({"expression": "7 * 6 + 12"}, config=config)
    return {"notes": [f"Computed sector checksum: {result}"]}


def critic(state: ResearchState) -> dict:
    time.sleep(0.6)
    return {"notes": [f"Reviewed {len(state['notes'])} notes — consistent."]}


def writer(state: ResearchState) -> dict:
    time.sleep(0.6)
    return {"answer": "Target node located at sector 7 (checksum 54)."}


def build_graph():
    graph = StateGraph(ResearchState)
    graph.add_node("planner", planner)
    graph.add_node("scout", scout)
    graph.add_node("analyst", analyst)
    graph.add_node("critic", critic)
    graph.add_node("writer", writer)

    graph.add_edge(START, "planner")
    graph.add_edge("planner", "scout")
    graph.add_edge("scout", "analyst")
    graph.add_edge("analyst", "critic")
    graph.add_edge("critic", "writer")
    graph.add_edge("writer", END)
    return graph.compile()


def main() -> None:
    # ---- the entire integration ----
    vis = VisualizerCallback(server_url="ws://localhost:8765")
    # --------------------------------

    app = build_graph()
    result = app.invoke(
        {"question": "Where is the target node?", "notes": [], "answer": ""},
        config={"callbacks": [vis]},
    )

    print("\nanswer:", result["answer"])
    for note in result["notes"]:
        print("  ·", note)

    time.sleep(2)  # let the last frames flush before we exit
    vis.close()


if __name__ == "__main__":
    main()
