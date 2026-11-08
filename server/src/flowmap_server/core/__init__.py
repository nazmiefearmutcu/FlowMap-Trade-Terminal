"""FlowMap server numerical core.

:mod:`flowmap_server.core.grid` holds the time-weighted density grid: epoch
management, the float16 column ring, and BarColumn accumulation.
"""

from flowmap_server.core.grid import FinalizedColumn, Grid, GridCfg

__all__ = ["FinalizedColumn", "Grid", "GridCfg"]
