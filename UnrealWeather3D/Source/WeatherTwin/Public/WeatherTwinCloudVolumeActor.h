#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "WeatherTwinTypes.h"
#include "WeatherTwinCloudVolumeActor.generated.h"

class UInstancedStaticMeshComponent;

UCLASS()
class WEATHERTWIN_API AWeatherTwinCloudVolumeActor : public AActor
{
    GENERATED_BODY()

public:
    AWeatherTwinCloudVolumeActor();

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="Weather Twin")
    FWeatherTwinRegion Region;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="Weather Twin")
    FString CloudMetaPath = TEXT("../data/weather/hrrr/volume/cloud-water-f01.json");

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="Weather Twin")
    int32 SampleStrideXY = 3;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="Weather Twin")
    int32 SampleStrideZ = 2;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="Weather Twin")
    uint8 DensityThreshold = 18;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="Weather Twin")
    float CloudBaseCm = 1600.0f;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="Weather Twin")
    float CloudHeightCm = 15000.0f;

protected:
    virtual void BeginPlay() override;
    virtual void OnConstruction(const FTransform& Transform) override;

private:
    UPROPERTY(VisibleAnywhere)
    UInstancedStaticMeshComponent* CloudVoxels = nullptr;

    void RebuildClouds();
};
