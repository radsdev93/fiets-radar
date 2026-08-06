# 🚲 fiets-radar 🌐 

> **Note on the name:** "Fiets" is Dutch for bicycle. I chose the name *fiets-radar* to reflect the service's purpose of globally tracking live bike availability across different municipal networks.

## Overview
This service tracks available bikes across a fixed list of 20 global cities using the public CityBikes API. It computes time-weighted hourly averages of free bikes while dynamically adapting its polling frequency to respect strict upstream rate limits.

## Architecture & Setup
*(Instructions for running the service, tests, and benchmark trace will be added as the architecture is finalized).*