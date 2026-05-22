#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "WeatherTwinTypes.h"
#include "WeatherTwinWindTrailsActor.generated.h"

UCLASS()
class WEATHERTWIN_API AWeatherTwinWindTrailsActor : public AActor
{
    GENERATED_BODY()

public:
    AWeatherTwinWindTrailsActor();

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="Weather Twin")
    FWeatherTwinRegion Region;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="Weather Twin")
    FString WindMetaPath = TEXT("../data/weather/hrrr/wind-volume/wind-f01.json");

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="Weather Twin")
    int32 HorizontalStride = 9;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="Weather Twin")
    int32 VerticalStride = 7;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="Weather Twin")
    float WindBaseCm = 1600.0f;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="Weather Twin")
    float WindHeightCm = 15000.0f;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="Weather Twin")
    float TrailScaleCmPerMeterSecond = 75.0f;

protected:
    virtual void BeginPlay() override;

private:
    void DrawWindTrails();
};
