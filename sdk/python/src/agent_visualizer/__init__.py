"""
agent-visualizer — watch your multi-agent AI workflow as a 2D retro game.

Quick start::

    pip install "agent-visualizer[server]"
    agent-visualizer serve          # bridge + dashboard on http://localhost:8765

Then, in your agent code::

    from agent_visualizer import VisualizerCallback

    vis = VisualizerCallback()
    graph.invoke(state, config={"callbacks": [vis]})   # LangGraph / LangChain

or drive it directly::

    from agent_visualizer import AgentVisualizerClient

    vis = AgentVisualizerClient()
    scout = vis.register("scout_1", name="Scout", avatar_type="rogue")
    scout.move_to(zone="library")
    scout.speak("Found it.", to="mage_1")

The client has no required dependencies; the bridge needs the ``[server]`` extra.
"""

from .client import (
    AVATAR_TYPES,
    DEFAULT_SERVER_URL,
    ZONE_KINDS,
    ZONES,
    AgentHandle,
    AgentVisualizerClient,
    VisualizerCallback,
    visualize_agent,
)

__version__ = "1.0.1"

__all__ = [
    "AgentVisualizerClient",
    "AgentHandle",
    "VisualizerCallback",
    "visualize_agent",
    "AVATAR_TYPES",
    "ZONES",
    "ZONE_KINDS",
    "DEFAULT_SERVER_URL",
    "__version__",
]


def serve(**kwargs):
    """
    Start the bridge and serve the dashboard (requires the ``[server]`` extra).

    Imported lazily so the client stays dependency-free for users who only
    produce events and run the bridge elsewhere.
    """
    from .bridge import serve as _serve

    return _serve(**kwargs)
