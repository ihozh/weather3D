#pragma once

#include "CoreMinimal.h"
#include "WeatherTwinTypes.generated.h"

USTRUCT(BlueprintType)
struct FWeatherTwinRegion
{
    GENERATED_BODY()

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="Weather Twin")
    double West = -88.75;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="Weather Twin")
    double South = 30.14;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="Weather Twin")
    double East = -85.65;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="Weather Twin")
    double North = 31.40;
};

USTRUCT(BlueprintType)
struct FMesonetStation
{
    GENERATED_BODY()

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="Weather Twin")
    FString Name;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="Weather Twin")
    double Latitude = 0.0;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="Weather Twin")
    double Longitude = 0.0;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="Weather Twin")
    bool bArchive = false;
};

USTRUCT(BlueprintType)
struct FWeatherVolumeMeta
{
    GENERATED_BODY()

    UPROPERTY(BlueprintReadOnly, Category="Weather Twin")
    int32 X = 0;

    UPROPERTY(BlueprintReadOnly, Category="Weather Twin")
    int32 Y = 0;

    UPROPERTY(BlueprintReadOnly, Category="Weather Twin")
    int32 Z = 0;

    UPROPERTY(BlueprintReadOnly, Category="Weather Twin")
    float SpeedP95MetersPerSecond = 1.0f;
};
