#pragma once

#include "CoreMinimal.h"
#include "WeatherTwinTypes.h"

namespace WeatherTwinGeo
{
    constexpr float TerrainWidthCm = 230000.0f;
    constexpr float TerrainDepthCm = 76000.0f;
    constexpr float HeightScaleCmPerMeter = 18.0f;

    FORCEINLINE FVector ToWorld(double Longitude, double Latitude, const FWeatherTwinRegion& Region, float HeightCm = 0.0f)
    {
        const double U = (Longitude - Region.West) / (Region.East - Region.West);
        const double V = (Latitude - Region.South) / (Region.North - Region.South);
        const float X = static_cast<float>((U - 0.5) * TerrainWidthCm);
        const float Y = static_cast<float>((0.5 - V) * TerrainDepthCm);
        return FVector(X, Y, HeightCm);
    }

    FORCEINLINE void ToLonLat(const FVector& World, const FWeatherTwinRegion& Region, double& OutLongitude, double& OutLatitude)
    {
        const double U = World.X / TerrainWidthCm + 0.5;
        const double V = 0.5 - World.Y / TerrainDepthCm;
        OutLongitude = Region.West + (Region.East - Region.West) * U;
        OutLatitude = Region.South + (Region.North - Region.South) * V;
    }

    FORCEINLINE float ProceduralElevationMeters(double Longitude, double Latitude)
    {
        const double Ridge = FMath::Sin(Longitude * 10.7) * FMath::Cos(Latitude * 12.3);
        const double Coast = FMath::Clamp((Latitude - 30.25) / 1.15, 0.0, 1.0);
        return static_cast<float>(8.0 + Coast * 58.0 + Ridge * 7.5);
    }

    FORCEINLINE float ElevationToHeightCm(float ElevationMeters)
    {
        return ElevationMeters * HeightScaleCmPerMeter;
    }
}
