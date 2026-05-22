#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "WeatherTwinTypes.h"
#include "WeatherTwinTerrainActor.generated.h"

class UProceduralMeshComponent;

UCLASS()
class WEATHERTWIN_API AWeatherTwinTerrainActor : public AActor
{
    GENERATED_BODY()

public:
    AWeatherTwinTerrainActor();

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="Weather Twin")
    FWeatherTwinRegion Region;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="Weather Twin")
    int32 SegmentsX = 260;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="Weather Twin")
    int32 SegmentsY = 176;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="Weather Twin")
    UMaterialInterface* TerrainMaterial = nullptr;

protected:
    virtual void OnConstruction(const FTransform& Transform) override;

private:
    UPROPERTY(VisibleAnywhere)
    UProceduralMeshComponent* Mesh = nullptr;

    void BuildTerrain();
};
