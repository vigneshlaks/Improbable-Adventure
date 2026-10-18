"""A client for the environment server: one JSON object per line over the pipes of a Node process.

This file needs nothing outside the standard library, so the protocol can be tested without any learning libraries.
"""
import json
import os
import subprocess
from dataclasses import dataclass
from typing import List, Optional, Sequence

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def default_command() -> List[str]:
    """How to start the server: `PDA_ENV_COMMAND` (a shell-style string) if set, otherwise the repository's own tsx."""
    override = os.environ.get("PDA_ENV_COMMAND")
    if override:
        import shlex

        return shlex.split(override)
    return [os.path.join(REPO_ROOT, "node_modules", ".bin", "tsx"), os.path.join(REPO_ROOT, "packages", "env-server", "src", "bin.ts")]


class EnvError(RuntimeError):
    """The server refused a request (a bad action, a bad seed list, an unknown command)."""


@dataclass
class StepResult:
    """What came back for a batch of games: one entry per game in every list."""

    obs: List[List[float]]
    masks: List[List[bool]]
    rewards: List[float]
    dones: List[bool]
    truncated: List[bool]
    won: List[bool]
    turns: List[int]
    certainty_left: List[float]


def _result(reply: dict) -> StepResult:
    return StepResult(
        obs=reply["obs"],
        masks=reply["masks"],
        rewards=reply["rewards"],
        dones=reply["dones"],
        truncated=reply["truncated"],
        won=reply["won"],
        turns=reply["turns"],
        certainty_left=reply["certaintyLeft"],
    )


class EnvServer:
    """A running server process. Use it as a context manager, or call `close()`."""

    def __init__(self, command: Optional[Sequence[str]] = None, cwd: str = REPO_ROOT) -> None:
        self._process = subprocess.Popen(
            list(command or default_command()),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            text=True,
            bufsize=1,
            cwd=cwd,
        )
        self._info: Optional[dict] = None

    def _call(self, request: dict) -> dict:
        if self._process.poll() is not None:
            raise EnvError("The environment server has stopped")
        assert self._process.stdin is not None and self._process.stdout is not None
        self._process.stdin.write(json.dumps(request) + "\n")
        self._process.stdin.flush()
        line = self._process.stdout.readline()
        if not line:
            raise EnvError("The environment server closed its output")
        reply = json.loads(line)
        if "error" in reply:
            raise EnvError(reply["error"])
        return reply

    def info(self) -> dict:
        """`obsSize`, `nActions` and a readable `labels` list for the action indices."""
        if self._info is None:
            self._info = self._call({"cmd": "info"})
        return self._info

    def reset(self, seeds: Sequence[str], indices: Optional[Sequence[int]] = None) -> StepResult:
        """Starts one game per seed, or, given `indices`, restarts just those games."""
        request: dict = {"cmd": "reset", "seeds": [str(s) for s in seeds]}
        if indices is not None:
            request["indices"] = list(indices)
        return _result(self._call(request))

    def step(self, actions: Sequence[int]) -> StepResult:
        """One action index per game. A game that has ended repeats its last reply until it is reset."""
        return _result(self._call({"cmd": "step", "actions": [int(a) for a in actions]}))

    def close(self) -> None:
        if self._process.poll() is None:
            assert self._process.stdin is not None
            self._process.stdin.close()
            try:
                self._process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._process.kill()

    def __enter__(self) -> "EnvServer":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()
