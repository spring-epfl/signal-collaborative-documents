# End-to-end encrypted collaborative documents, using Automerge and Signal

## Dependencies

You will need Docker to run the experiments. 
To generate plots from the raw benchmark data, you will need [uv](https://docs.astral.sh/uv/). 

We give scripts for installing (non-Docker) dependencies on Linux (`./install-dependencies-linux.sh`) and MacOS (`./install-dependencies-macos.sh`). You may either call these scripts directly, or manually follow the installation commands therein.

## Benchmarking

We provide bash scripts `experiment-{1,2,3}.sh` for each of our experiments. These scripts should be run in the base repository (on your machine). 

Internally, each script builds a docker container, optionally artificially restricts the container's network, runs benchmarks inside the container, and generates plots from the resulting data. 
If you encounter an error while benchmarking, check `signal-cli.{1,2,3,4}.log` for more information. 

### Experiment 1 -- Asynchronous Collaboration

Run `experiment-1.sh`. Check `benchmark_data/s1-signal{slow,fast}` (raw data) and `benchmark_plots/s1-cumulative-both.pdf` (plot) for runtimes in an asynchronous collaboration setting.

### Experiment 2 -- Synchronous Collaboration

Run `experiment-2.sh`. Check `benchmark_data/s{2,3}-signal{slow,fast}` (raw
data) and `benchmark_plots/s2-slow-vs-fast-split-violins.pdf`
(plot) for runtimes in a synchronous collaboration setting.

### Experiment 3 -- Large Edits

Run `experiment-3.sh`. Check
`benchmark_data/s4-large-edits.csv` (raw data)
and `benchmark_plots/s4.pdf` (plot) to see runtimes in a setting with large edits. 

### Debug info

Internally, each experiment script runs `./netprofile.sh <slow|fast|off>` to restrict the network ("slow" or "fast" setting, or to use the network to its fully capacity (`off`)), and then invokes a `b*.sh` script to run the benchmark. The result of the benchmark will be printed in the console, and will also be written to `benchmark_data/*.csv`.

## (alternative) Benchmarking manually

### Setup

Set up the docker container with

```bash
docker-compose up --build -d
./netprofile.sh [slow|fast|off] # Sets latency and bandwidth in container
docker exec -it e2ee-cd /bin/bash  # Open shell in Docker container
```

Start the signal-cli daemon with

```bash
signal-cli --config=./signal-data/signal-multiaccount daemon --http  
```

If you want to run the benchmark for only one user, use

```bash
signal-cli --config=./signal-data/signal-multiaccount -a=$NUMBER daemon --http 
```

For usability, you might want to `source .env`, which exports the variables `ACCOUNT_1` and `ACCOUNT_2`.

If you get a warning `WARN  MultiAccountManager - Ignoring $NUMBER: User is not registered. (NotRegisteredException)`: register the signal number as follows (see [signal-cli Wiki](https://github.com/AsamK/signal-cli/wiki/Linking-other-devices-(Provisioning))):

```bash
signal-cli --config=./signal-data/signal-multiaccount link -n "${OPTIONAL_DEVICE_NAME} | tee >(xargs -L 1 qrencode -t utf8)
```

Then scan the QR code with a primary device where you are already logged in with the Signal account for `$NUMBER`.
Alternatively, if your device does not recognize the QR code shown by qrencode, get the link by running `signal-cli --config=./signal-data/signal-multiaccount link -n "${OPTIONAL_DEVICE_NAME}"` and paste the `sgnl://linkdevice?uuid=...` link in your favorite QR code generator (e.g., search for "qr code for $LINK" on DuckDuckGo).

### Running benchmarks

In another shell on the same docker container, run one of `b{1,2,4}.sh`. 

## Generating the plots

We use [uv](https://docs.astral.sh/uv/) to manage Python dependencies. To run the Jupyter notebooks, run the following command to automatically read the data in `benchmark_data` and generate plots in `benchmark_plots`.

```bash
uv run --with jupyter jupyter execute analysis-1.ipynb
uv run --with jupyter jupyter execute analysis-2-3.ipynb
uv run --with jupyter jupyter execute analysis_4.ipynb
```

Alternatively, make sure that you have the correct Python version specified in [.python-version](.python-version), install the dependencies listed in [pyproject.toml](pyproject.toml) along with `jupyter` using your favorite Python package manager, and launch `jupyter`.
